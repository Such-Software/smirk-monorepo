import { fetch } from '@tauri-apps/plugin-http';
import { open } from '@tauri-apps/plugin-shell';
import { installNativeFetch } from '../../extension/src/popup/native-fetch';
import { installExternalOpener } from '../../extension/src/popup/open-external';

/** Bundle the native transport and install it before the first swap quote.
 *  Also route external links (block explorers) to the system browser: the
 *  webview drops a plain `window.open`, which left Activity rows inert. */
export function installDesktopHttp(): void {
  installNativeFetch(fetch);
  installExternalOpener((url) => open(url));
}
