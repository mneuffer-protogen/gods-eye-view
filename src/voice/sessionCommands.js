import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';

/** Bind common controls to a supplied voice-session adapter. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  createSession,
  createController,
  backend,
  signal,
  debugSink,
  createControl = createVoiceControl,
  // Optional `({ signal }) => Promise<boolean|null>`: false means the server
  // has no voice provider configured, so voice shows as off instead of
  // failing on first use. Null or absent keeps the mic as it is.
  availability = null,
}) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) =>
      createSession({
        ...hooks,
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    ui.status.textContent =
      event.state === 'idle' ? 'OFF' : event.state.toUpperCase();
    ui.detail.textContent =
      event.detail || (event.state === 'idle' ? 'Voice off' : 'Voice active');
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || 'Voice could not be started.'
          : '';
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  let unconfigured = false;
  const markUnconfigured = () => {
    unconfigured = true;
    ui.root.dataset.status = 'unconfigured';
    ui.status.textContent = 'OFF';
    ui.detail.textContent = 'VOICE OFF · NO OPENAI KEY';
    ui.button.setAttribute('aria-disabled', 'true');
    ui.button.setAttribute(
      'aria-label',
      'Voice control is off: add OPENAI_API_KEY to enable it',
    );
    if (ui.helpDetail)
      ui.helpDetail.textContent =
        'Voice is optional. Add OPENAI_API_KEY to enable it; everything else works without it.';
    if (ui.tierButton) ui.tierButton.hidden = true;
    if (ui.costValue) ui.costValue.hidden = true;
  };
  const buttonHandler = () => {
    if (unconfigured) return;
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) session.stop();
    else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      annotationUnsubscribe?.();
      updateStatus();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    annotationUnsubscribe?.();
    updateStatus();
    ui.root.remove();
  } else if (availability) {
    // Bind shortcuts only once voice is known to be possible, so a keyless
    // app never arms push-to-talk on Space.
    void Promise.resolve()
      .then(() => availability({ signal: session.signal }))
      .catch(() => null)
      .then((configured) => {
        if (session.disposed || session.signal.aborted) return;
        if (configured === false && !session.isActive()) markUnconfigured();
        else adapter.bindControls?.();
      });
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
