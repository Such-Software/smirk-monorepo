import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

let promptOpen = false;

/** Password state belongs only to this dialog and is cleared after each attempt. */
export function promptOperationPassword(
  description: string,
  verify: (password: string) => Promise<void>,
): Promise<void> {
  if (promptOpen) return Promise.reject(new Error('Another password confirmation is open. Finish it first.'));
  promptOpen = true;
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Promise((resolve, reject) => {
    let closed = false;
    const finish = (confirmed: boolean) => {
      if (closed) return;
      closed = true;
      render(null, host);
      host.remove();
      promptOpen = false;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      if (confirmed) resolve();
      else reject(new Error('Password confirmation canceled.'));
    };
    function Dialog() {
      const [password, setPassword] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const panel = useRef<HTMLFormElement>(null);
      const input = useRef<HTMLInputElement>(null);
      useEffect(() => { input.current?.focus(); }, []);
      const submit = async (event: Event) => {
        event.preventDefault();
        if (busy || !password) return;
        setBusy(true);
        setError(null);
        try {
          await verify(password);
          setPassword('');
          finish(true);
        } catch (failure) {
          if (!closed) {
            setPassword('');
            setError(failure instanceof Error ? failure.message : 'Password confirmation failed.');
            setBusy(false);
            input.current?.focus();
          }
        }
      };
      return <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.75)', display: 'grid', placeItems: 'center', padding: 16 }}>
        <form ref={panel} role="dialog" aria-modal="true" aria-labelledby="operation-password-title"
          onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPassword(''); finish(false); }
            if (event.key === 'Tab') {
              const controls = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
              const first = controls[0]; const last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}
          style={{ maxWidth: 360, width: '100%', padding: 20, borderRadius: 10, background: 'var(--smirk-bg, #18181b)', color: 'var(--smirk-fg, #fff)', border: '1px solid var(--smirk-border, #444)' }}>
          <h2 id="operation-password-title" style={{ marginTop: 0, fontSize: 17 }}>Confirm with password</h2>
          <p style={{ fontSize: 13 }}>{description}</p>
          <label style={{ display: 'block', fontSize: 12 }}>
            Wallet password
            <input ref={input} type="password" autoComplete="current-password" value={password}
              data-testid="operation-password" disabled={busy}
              onInput={(event) => setPassword(event.currentTarget.value)}
              style={{ display: 'block', boxSizing: 'border-box', width: '100%', padding: 10, marginTop: 6 }} />
          </label>
          <p style={{ fontSize: 11, opacity: 0.7 }}>This confirms one action. Your auto-lock deadline stays the same.</p>
          {error && <p role="alert" style={{ fontSize: 12, color: 'var(--smirk-danger, #ef4444)' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setPassword(''); finish(false); }}>Cancel</button>
            <button type="submit" disabled={busy || !password} data-testid="operation-password-confirm">{busy ? 'Checking…' : 'Confirm'}</button>
          </div>
        </form>
      </div>;
    }
    render(<Dialog />, host);
  });
}
