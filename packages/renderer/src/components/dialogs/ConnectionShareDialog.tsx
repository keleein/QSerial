/**
 * 连接共享对话框
 * 支持共享任意类型的活跃连接（串口、SSH、Telnet、PTY）
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '@/stores/terminal';
import { useConfigStore } from '@/stores/config';
import { ConnectionType, ConnectionState } from '@qserial/shared';

interface ConnectionShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSessionId?: string;
}

interface ActiveSession {
  sessionId: string;
  connectionId: string;
  connectionType: ConnectionType;
  name: string;
  description: string;
  state: ConnectionState;
}

interface SessionInfo {
  connectionId: string;
  connectionType: ConnectionType;
  connectionState: ConnectionState;
  name: string;
  serialPath?: string;
  host?: string;
}

export const ConnectionShareDialog: React.FC<ConnectionShareDialogProps> = ({
  isOpen,
  onClose,
  defaultSessionId,
}) => {
  const { t } = useTranslation();
  const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
    [ConnectionType.SERIAL]: t('dialogs.share.typeSerial'),
    [ConnectionType.SSH]: 'SSH',
    [ConnectionType.TELNET]: 'Telnet',
    [ConnectionType.PTY]: t('dialogs.share.typeLocalTerminal'),
    [ConnectionType.SERIAL_SERVER]: t('dialogs.share.typeSerialShare'),
    [ConnectionType.CONNECTION_SERVER]: t('dialogs.share.typeConnectionShare'),
  };
  const terminalState = useTerminalStore();
  const sessions = terminalState?.sessions || {};
  const { config, updateConfig } = useConfigStore();
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const [status, setStatus] = useState<{
    running: boolean;
    sourceType: 'existing' | 'new';
    sourceDescription: string;
    localPort: number;
    listenAddress: string;
    clientCount: number;
    clients: string[];
    hasPassword: boolean;
  } | null>(null);

  // 获取活跃会话列表
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');

  // 服务配置
  const localPort =
    config.connectionShare?.defaultLocalPort || config.serialShare?.defaultLocalPort || 8888;
  const [localPortValue, setLocalPortValue] = useState(localPort);
  const [listenAddress, setListenAddress] = useState(
    config.connectionShare?.defaultListenAddress ||
      config.serialShare?.defaultListenAddress ||
      '0.0.0.0'
  );
  const [accessPassword, setAccessPassword] = useState('');

  // 服务ID
  const serverId = selectedSessionId ? `conn-server-${selectedSessionId.slice(0, 8)}` : '';

  // 计算活跃会话
  useEffect(() => {
    const active: ActiveSession[] = [];
    for (const [sessionId, session] of Object.entries(sessions) as [string, SessionInfo][]) {
      if (session.connectionState === ConnectionState.CONNECTED) {
        let description = '';
        switch (session.connectionType) {
          case ConnectionType.SERIAL:
            description = session.serialPath || t('dialogs.share.typeSerial');
            break;
          case ConnectionType.SSH:
            description = session.host || 'SSH';
            break;
          case ConnectionType.TELNET:
            description = session.host || 'Telnet';
            break;
          case ConnectionType.PTY:
            description = t('dialogs.share.typeLocalTerminal');
            break;
          default:
            description =
              CONNECTION_TYPE_LABELS[session.connectionType] || t('dialogs.share.typeUnknown');
        }

        active.push({
          sessionId,
          connectionId: session.connectionId,
          connectionType: session.connectionType,
          name: session.name,
          description,
          state: session.connectionState,
        });
      }
    }
    setActiveSessions(active);

    // 自动选择默认会话
    if (!selectedSessionId && defaultSessionId) {
      const found = active.find((s) => s.sessionId === defaultSessionId);
      if (found) {
        setSelectedSessionId(found.sessionId);
      }
    }
    // 如果当前选中的会话不再活跃，清除选择
    if (selectedSessionId && !active.find((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId('');
    }
  }, [sessions, defaultSessionId]);

  // 轮询状态
  useEffect(() => {
    if (!isOpen || !serverId) return;
    const pollStatus = async () => {
      try {
        const s = await window.qserial.connectionServer.getStatus(serverId);
        setStatus(s);
      } catch {
        setStatus(null);
      }
    };
    pollStatus();
    const timer = setInterval(pollStatus, 2000);
    return () => clearInterval(timer);
  }, [isOpen, serverId]);

  // 监听 MCP 创建的共享变化（跨代码路径同步）
  useEffect(() => {
    if (!isOpen) return;
    const unsub = window.qserial.mcp.onShareChanged(
      (event: {
        shareId: string;
        running: boolean;
        sourceId?: string;
        localPort?: number;
        listenAddress?: string;
      }) => {
        if (event.running) {
          setStatus({
            running: true,
            sourceType: 'existing',
            sourceDescription: `MCP (${event.sourceId?.slice(0, 8) || '?'})`,
            localPort: event.localPort || 0,
            listenAddress: event.listenAddress || '',
            clientCount: 0,
            clients: [],
            hasPassword: false,
          });
        } else {
          setStatus((prev) => (prev?.localPort === event.localPort ? null : prev));
        }
      }
    );
    return () => {
      unsub?.();
    };
  }, [isOpen]);

  const handleStart = async () => {
    setError(null);
    setIsStarting(true);

    if (!selectedSessionId) {
      setError(t('dialogs.share.selectActive'));
      setIsStarting(false);
      return;
    }

    const session = activeSessions.find((s) => s.sessionId === selectedSessionId);
    if (!session) {
      setError(t('dialogs.share.sessionNotFound'));
      setIsStarting(false);
      return;
    }

    try {
      const options = {
        id: serverId,
        sourceType: 'existing' as const,
        existingConnectionId: session.connectionId,
        localPort: localPortValue,
        listenAddress,
        ...(accessPassword ? { accessPassword } : {}),
      };

      await window.qserial.connectionServer.start(options);

      // 保存配置
      updateConfig('connectionShare', {
        defaultLocalPort: localPortValue,
        defaultListenAddress: listenAddress,
      });

      setShowSuccessDialog(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      await window.qserial.connectionServer.stop(serverId);
      setStatus(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const isRunning = status?.running ?? false;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 dialog-overlay flex items-center justify-center z-50">
      <div className="dialog-content bg-surface rounded-xl w-[540px] max-h-[85vh] flex flex-col overflow-hidden border border-white/5">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-primary"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            <h3 className="text-base font-semibold">{t('dialogs.share.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="dialog-close w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 flex-1 overflow-y-auto min-h-0 p-5">
          {/* 数据源选择 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('dialogs.share.selectActive')}
            </label>
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              disabled={isRunning}
              className="dialog-select"
            >
              <option value="">{t('dialogs.share.selectPlaceholder')}</option>
              {activeSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  [{CONNECTION_TYPE_LABELS[s.connectionType]}] {s.description} - {s.name}
                </option>
              ))}
            </select>

            {activeSessions.length === 0 && (
              <p className="text-xs text-yellow-500 mt-1.5">{t('dialogs.share.noActive')}</p>
            )}

            {selectedSessionId && (
              <div className="mt-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-xs text-text-secondary">
                  {t('dialogs.share.selectedInfo')}
                </span>
              </div>
            )}
          </div>

          {/* 本地监听端口 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('dialogs.share.localListenPort')}
            </label>
            <input
              type="number"
              value={localPortValue}
              onChange={(e) => setLocalPortValue(Number(e.target.value))}
              disabled={isRunning}
              className="dialog-input"
              min={1}
              max={65535}
            />
          </div>

          {/* 监听地址 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('dialogs.share.listenAddress')}
            </label>
            <select
              value={listenAddress}
              onChange={(e) => setListenAddress(e.target.value)}
              disabled={isRunning}
              className="dialog-select"
            >
              <option value="0.0.0.0">0.0.0.0 ({t('dialogs.share.allInterfaces')})</option>
              <option value="127.0.0.1">127.0.0.1 ({t('dialogs.share.localOnly')})</option>
            </select>
            <p className="text-xs text-text-secondary/50 mt-1">{t('dialogs.share.listenHint')}</p>
          </div>

          {/* 访问密码 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('dialogs.share.accessPassword')}{' '}
              <span className="text-text-secondary/50 font-normal">
                ({t('dialogs.share.passwordOptionalHint')})
              </span>
            </label>
            <input
              type="password"
              value={accessPassword}
              onChange={(e) => setAccessPassword(e.target.value)}
              disabled={isRunning}
              className="dialog-input"
              placeholder={t('dialogs.share.passwordPlaceholder')}
            />
            <p className="text-xs text-text-secondary/50 mt-1">{t('dialogs.share.passwordHint')}</p>
          </div>

          {/* 状态 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-3 h-3 rounded-full ${isRunning ? 'bg-green-500' : 'bg-gray-500'}`}
              />
              <span className="text-sm">
                {isRunning
                  ? t('dialogs.share.runningStatus', {
                      source: status?.sourceDescription || '',
                      address: status?.listenAddress || '0.0.0.0',
                      port: localPortValue,
                      password: status?.hasPassword ? t('dialogs.share.hasPassword') : '',
                    })
                  : t('dialogs.share.stoppedStatus')}
              </span>
            </div>
            {isRunning && status && status.clients.length > 0 && (
              <div className="ml-5 text-xs text-text-secondary space-y-0.5">
                <p className="font-medium text-text-secondary/80">
                  {t('dialogs.share.telnetClients', { count: status.clientCount })}：
                </p>
                {status.clients.map((addr) => (
                  <p key={addr} className="ml-2 font-mono">
                    {addr}
                  </p>
                ))}
              </div>
            )}
            {isRunning && status && status.clientCount > 1 && (
              <p className="ml-5 text-xs text-yellow-500">{t('dialogs.share.multiClientHint')}</p>
            )}
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-error bg-error/10 border-l-2 border-error px-3 py-2.5 rounded-r-lg">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
                className="flex-shrink-0"
              >
                <path d="M7 0a7 7 0 100 14A7 7 0 007 0zm0 10.5a.75.75 0 110-1.5.75.75 0 010 1.5zM7.75 4v3.5a.75.75 0 01-1.5 0V4a.75.75 0 011.5 0z" />
              </svg>
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2">
            {isRunning ? (
              <button
                onClick={handleStop}
                className="dialog-btn flex-1 bg-error text-white hover:bg-error/80 rounded-md"
              >
                {t('dialogs.share.stopShare')}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={!selectedSessionId || isStarting || activeSessions.length === 0}
                className="dialog-btn dialog-btn-primary flex-1 disabled:opacity-50"
              >
                {isStarting ? t('dialogs.share.starting') : t('dialogs.share.startShare')}
              </button>
            )}
          </div>

          {/* 使用说明 */}
          <div className="text-xs text-text-secondary bg-background/50 rounded-lg p-3 space-y-1">
            <p className="font-medium text-text-secondary/80">{t('dialogs.share.usageTitle')}</p>
            <p>{t('dialogs.share.usage1')}</p>
            <p>{t('dialogs.share.usage2')}</p>
            <p>{t('dialogs.share.usage3')}</p>
          </div>
        </div>

        {/* 关闭按钮 */}
        <div className="flex justify-end px-5 py-4 border-t border-border bg-background/30 flex-shrink-0">
          <button onClick={onClose} className="dialog-btn dialog-btn-secondary">
            {t('dialogs.share.close')}
          </button>
        </div>
      </div>

      {/* 启动成功提示对话框 */}
      {showSuccessDialog && (
        <div className="fixed inset-0 bg-black/60 dialog-overlay flex items-center justify-center z-[60]">
          <div className="dialog-content bg-surface rounded-xl p-5 w-[480px] max-h-[80vh] flex flex-col border border-white/5">
            <h3 className="text-base font-semibold mb-4 flex items-center gap-2 text-success">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              {t('dialogs.share.startedTitle')}
            </h3>

            <div className="space-y-4 flex-1 overflow-y-auto">
              <div className="bg-background/50 rounded p-3">
                <p className="text-sm text-text-secondary mb-2">
                  {t('dialogs.share.connectionInfo')}
                </p>
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="text-text-secondary">{t('dialogs.share.source')}</span>
                    {status?.sourceDescription || t('dialogs.share.typeUnknown')}
                  </p>
                  <p>
                    <span className="text-text-secondary">{t('dialogs.share.telnetPort')}</span>
                    {listenAddress}:{localPortValue}
                  </p>
                  {accessPassword && (
                    <p>
                      <span className="text-text-secondary">
                        {t('dialogs.share.accessPasswordLabel')}
                      </span>
                      {t('dialogs.share.passwordSet')}
                    </p>
                  )}
                </div>
              </div>

              <div className="bg-primary/10 border border-primary/30 rounded-lg p-3">
                <p className="text-sm font-medium mb-2">{t('dialogs.share.humanTerminal')}</p>
                <div className="bg-background rounded-md p-2 font-mono text-sm">
                  telnet {t('dialogs.share.localIpPlaceholder')} {localPortValue}
                </div>
                <button
                  onClick={async () => {
                    try {
                      const ip = await window.qserial.getLocalIp();
                      await navigator.clipboard.writeText(`telnet ${ip} ${localPortValue}`);
                    } catch {
                      await navigator.clipboard.writeText(
                        `telnet ${t('dialogs.share.localIpPlaceholder')} ${localPortValue}`
                      );
                    }
                  }}
                  className="mt-2 px-3 py-1.5 text-sm bg-primary/20 hover:bg-primary/30 rounded-md transition-colors"
                >
                  {t('dialogs.share.copyTelnetCmd')}
                </button>
                {accessPassword && (
                  <p className="text-xs text-yellow-500 mt-2">{t('dialogs.share.authHint')}</p>
                )}
              </div>
            </div>

            <div className="flex justify-end mt-4 pt-4 border-t border-border">
              <button
                onClick={() => setShowSuccessDialog(false)}
                className="dialog-btn dialog-btn-primary"
              >
                {t('dialogs.share.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
