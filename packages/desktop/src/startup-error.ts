/** Keep untrusted exception strings and private runtime state out of the UI. */
export type StartupStage = 'native HTTP' | 'browser services' | 'wallet interface';

export function showStartupError(root: HTMLElement, stage: StartupStage): void {
  const panel = root.ownerDocument.createElement('div');
  panel.style.cssText = 'padding:32px;font-family:system-ui,sans-serif;color:#f5f5f5;background:#0e0e10;min-height:100vh';
  const heading = root.ownerDocument.createElement('h1');
  heading.textContent = 'Smirk Wallet: startup error';
  const message = root.ownerDocument.createElement('p');
  message.textContent = `Smirk could not start ${stage}. Close and reopen the app. If this continues, include this stage when contacting support.`;
  panel.append(heading, message);
  root.replaceChildren(panel);
}
