import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { resolveUploadPaths } from '../../lib/upload-paths.js';

describe('resolveUploadPaths', () => {
  test('allows files and symlinks that resolve inside the upload directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-uploads-'));
    try {
      const nested = path.join(root, 'nested');
      const file = path.join(nested, 'file.txt');
      await fs.mkdir(nested);
      await fs.writeFile(file, 'ok');
      await fs.symlink(file, path.join(root, 'link.txt'));
      const realFile = await fs.realpath(file);
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [file, path.join(root, 'link.txt')] }))
        .resolves.toEqual([realFile, realFile]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('rejects traversal and symlinks outside the upload directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-uploads-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret');
      await fs.symlink(outsideFile, path.join(root, 'escape.txt'));
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [outsideFile] }))
        .rejects.toMatchObject({ code: 'upload_path_outside_root' });
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [path.join(root, 'escape.txt')] }))
        .rejects.toMatchObject({ code: 'upload_path_outside_root' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  test('rejects empty, relative, null byte, and non-regular file paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-uploads-'));
    try {
      const directory = path.join(root, 'directory');
      await fs.mkdir(directory);

      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [''] }))
        .rejects.toMatchObject({ code: 'invalid_upload_path' });
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: ['relative.txt'] }))
        .rejects.toMatchObject({ code: 'invalid_upload_path' });
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [path.join(root, 'file\0.txt')] }))
        .rejects.toMatchObject({ code: 'invalid_upload_path' });
      await expect(resolveUploadPaths({ uploadsDir: root, filePaths: [directory] }))
        .rejects.toMatchObject({ code: 'invalid_upload_path' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('creates a missing upload directory instead of failing', async () => {
    const missing = path.join(os.tmpdir(), `camofox-missing-uploads-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await expect(resolveUploadPaths({ uploadsDir: missing, filePaths: [] })).resolves.toEqual([]);
      const stat = await fs.stat(missing);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(missing, { recursive: true, force: true });
    }
  });

  test('reports the expected root when a path escapes the upload directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-uploads-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret');
      const err = await resolveUploadPaths({ uploadsDir: root, filePaths: [outsideFile] })
        .then(() => null, (e) => e);
      expect(err).toMatchObject({ code: 'upload_path_outside_root' });
      // 报错必须自带可操作指引：把期望目录直接回执给调用方
      expect(err.message).toContain(await fs.realpath(root));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
