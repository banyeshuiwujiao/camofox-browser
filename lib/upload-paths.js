import fs from 'node:fs/promises';
import path from 'node:path';

function uploadPathError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function isInside(basePath, targetPath) {
  const normBase = path.resolve(basePath);
  const normTarget = path.resolve(targetPath);
  const isWin = process.platform === 'win32';
  const base = isWin ? normBase.toLowerCase() : normBase;
  const target = isWin ? normTarget.toLowerCase() : normTarget;

  const relative = path.relative(base, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !relative.startsWith(`..${path.posix.sep}`)
    && !path.isAbsolute(relative);
}

export async function resolveUploadPaths({ uploadsDir, filePaths }) {
  let realUploadsDir;
  try {
    realUploadsDir = await fs.realpath(uploadsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      try {
        await fs.mkdir(uploadsDir, { recursive: true });
        realUploadsDir = await fs.realpath(uploadsDir);
      } catch (mkdirErr) {
        throw uploadPathError(`Upload directory is not available and could not be created at: ${uploadsDir} (${mkdirErr.message})`, 'uploads_dir_not_found');
      }
    } else {
      throw err;
    }
  }

  return Promise.all(filePaths.map(async (filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw uploadPathError('path entries must be non-empty strings', 'invalid_upload_path');
    }
    if (filePath.includes('\0')) {
      throw uploadPathError('path contains invalid characters', 'invalid_upload_path');
    }
    if (!path.isAbsolute(filePath)) {
      throw uploadPathError(`path entries must be absolute paths within the upload directory: ${realUploadsDir}`, 'invalid_upload_path');
    }

    const normalizedPath = path.resolve(filePath);
    if (!isInside(realUploadsDir, normalizedPath)) {
      throw uploadPathError(`path resolves outside the upload directory. Expected path inside: ${realUploadsDir}, got: ${normalizedPath}. Please place your file in: ${realUploadsDir}`, 'upload_path_outside_root');
    }

    let realFilePath;
    try {
      realFilePath = await fs.realpath(normalizedPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw uploadPathError(`file not found in upload directory: ${filePath}`, 'file_not_found');
      }
      throw err;
    }

    if (!isInside(realUploadsDir, realFilePath)) {
      throw uploadPathError(`path resolves outside the upload directory. Expected path inside: ${realUploadsDir}, got: ${realFilePath}. Please place your file in: ${realUploadsDir}`, 'upload_path_outside_root');
    }

    const stat = await fs.stat(realFilePath);
    if (!stat.isFile()) {
      throw uploadPathError('path must identify a file', 'invalid_upload_path');
    }
    return realFilePath;
  }));
}
