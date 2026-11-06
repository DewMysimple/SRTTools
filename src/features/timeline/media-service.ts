import { convertFileSrc, invoke } from '@tauri-apps/api/core';

interface VideoGrant {
  token: string;
  name: string;
}

export interface VideoSource extends VideoGrant {
  url: string;
}

export async function chooseVideo(): Promise<VideoSource | null> {
  const grant = await invoke<VideoGrant | null>('select_video');
  return grant && { ...grant, url: convertFileSrc(grant.token, 'srtmedia') };
}

export function releaseVideo(token: string): Promise<void> {
  return invoke('release_video', { token });
}

export function resetVideo(element: HTMLVideoElement | null) {
  if (!element) return;
  element.pause();
  element.removeAttribute('src');
  element.load();
}
