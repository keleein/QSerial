/**
 * SFTP MCP 工具处理函数
 */

import { formatOk, formatError } from '../ai-helpers.js';
import {
  createSftp,
  destroySftp,
  listDirectory,
  downloadFile,
  uploadFile,
  mkdir as sftpMkdir,
  rm as sftpRm,
  stat as sftpStat,
} from '../../sftp/manager.js';
import type { ToolHandler } from '../types';

export const sftpHandlers: Record<string, ToolHandler> = {
  'sftp.standalone_connect': async (args) => {
    const host = args.host as string;
    const port = (args.port as number) || 22;
    const username = args.username as string;
    if (!host || !username) return formatError('MISSING_PARAM', 'missing host or username');
    const { createStandaloneSftp } = await import('../../sftp/manager.js');
    try {
      const sftpId = await createStandaloneSftp({
        host,
        port,
        username,
        password: args.password as string | undefined,
        privateKey: args.private_key as string | undefined,
      });
      return formatOk({ sftp_id: sftpId, host, port, username });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.connect': async (args) => {
    const sftpConnId = (args.id || args.connectionId) as string;
    if (!sftpConnId) return formatError('MISSING_PARAM', 'missing id');
    try {
      const sftpId = await createSftp(sftpConnId);
      return formatOk({ sftp_id: sftpId, connection_id: sftpConnId });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.disconnect': async (args) => {
    const sftpSid = args.sftp_id as string;
    if (!sftpSid) return formatError('MISSING_PARAM', 'missing sftp_id');
    try {
      await destroySftp(sftpSid);
      return formatOk({ disconnected: sftpSid });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.list': async (args) => {
    const sftpSid = args.sftp_id as string;
    const dirPath = (args.path as string) || '/';
    if (!sftpSid) return formatError('MISSING_PARAM', 'missing sftp_id');
    try {
      const files = await listDirectory(sftpSid, dirPath);
      return formatOk({ path: dirPath, count: files.length, files });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.download': async (args) => {
    const sftpSid = args.sftp_id as string;
    const remotePath = args.remote_path as string;
    const localPath = args.local_path as string;
    if (!sftpSid || !remotePath || !localPath)
      return formatError('MISSING_PARAM', 'missing params');
    try {
      await downloadFile(sftpSid, remotePath, localPath);
      return formatOk({ downloaded: remotePath, to: localPath });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.upload': async (args) => {
    const sftpSid = args.sftp_id as string;
    const localPath = args.local_path as string;
    const remotePath = args.remote_path as string;
    if (!sftpSid || !localPath || !remotePath)
      return formatError('MISSING_PARAM', 'missing params');
    try {
      await uploadFile(sftpSid, localPath, remotePath);
      return formatOk({ uploaded: localPath, to: remotePath });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.mkdir': async (args) => {
    const sftpSid = args.sftp_id as string;
    const dirPath = args.path as string;
    if (!sftpSid || !dirPath) return formatError('MISSING_PARAM', 'missing params');
    try {
      await sftpMkdir(sftpSid, dirPath);
      return formatOk({ created: dirPath });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.stat': async (args) => {
    const sftpSid = args.sftp_id as string;
    const statPath = args.path as string;
    if (!sftpSid || !statPath) return formatError('MISSING_PARAM', 'missing params');
    try {
      const info = await sftpStat(sftpSid, statPath);
      return formatOk({ path: statPath, stat: info });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },

  'sftp.rm': async (args) => {
    const sftpSid = args.sftp_id as string;
    const rmPath = args.path as string;
    if (!sftpSid || !rmPath) return formatError('MISSING_PARAM', 'missing params');
    try {
      await sftpRm(sftpSid, rmPath);
      return formatOk({ deleted: rmPath });
    } catch (e: unknown) {
      return formatError('SFTP_ERROR', (e as Error).message || String(e));
    }
  },
};
