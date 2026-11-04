import { readLocalValue, writeLocalValue } from './persistence';

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  outputDirectory: string;
  fileNamePattern: string;
  outputEncoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gbk' | 'gb18030';
  lineEnding: 'LF' | 'CRLF';
  autoOpenDirectory: boolean;
  showPreview: boolean;
}

export const defaultSettings: AppSettings = {
  theme: 'light',
  outputDirectory: '',
  fileNamePattern: '{name}_processed',
  outputEncoding: 'utf-8',
  lineEnding: 'CRLF',
  autoOpenDirectory: false,
  showPreview: true,
};

function normalizeSettings(value: unknown): AppSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...defaultSettings };
  const raw = value as Record<string, unknown>;
  return {
    theme: raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'light',
    outputDirectory: typeof raw.outputDirectory === 'string' ? raw.outputDirectory : '',
    fileNamePattern: typeof raw.fileNamePattern === 'string' && raw.fileNamePattern.trim()
      ? raw.fileNamePattern : defaultSettings.fileNamePattern,
    outputEncoding: raw.outputEncoding === 'utf-8-bom' || raw.outputEncoding === 'utf-16le' || raw.outputEncoding === 'utf-16be' || raw.outputEncoding === 'gbk' || raw.outputEncoding === 'gb18030'
      ? raw.outputEncoding : 'utf-8',
    lineEnding: raw.lineEnding === 'LF' ? 'LF' : 'CRLF',
    autoOpenDirectory: raw.autoOpenDirectory === true,
    showPreview: raw.showPreview !== false,
  };
}

export function validateFileNamePattern(pattern: string): void {
  if (!pattern.trim()) throw new Error('请填写导出文件名规则。');
  // eslint-disable-next-line no-control-regex -- Reject Windows filename control characters.
  if (/[<>:"/\\|?*\x00-\x1f]/u.test(pattern)) throw new Error('文件名规则不能包含路径或 Windows 不支持的字符。');
  if (/\{(?!name\}|index\})[^}]*\}/u.test(pattern)) throw new Error('文件名规则只支持 {name} 和 {index} 占位符。');
  if (pattern.length > 180) throw new Error('文件名规则过长，请缩短到 180 个字符以内。');
}

export async function loadSettings(): Promise<AppSettings> {
  return normalizeSettings(await readLocalValue('settings'));
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  validateFileNamePattern(settings.fileNamePattern);
  await writeLocalValue('settings', normalizeSettings(settings));
}
