import { fetch } from '@tauri-apps/plugin-http';
import { installNativeFetch } from '../../extension/src/popup/native-fetch';

/** Bundle the native transport and install it before the first swap quote. */
export function installDesktopHttp(): void {
  installNativeFetch(fetch);
}
