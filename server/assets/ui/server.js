// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The Server tab: pairing, version and device, and the access token.

let pairStep = 'idle';

function renderServer() {
  renderPairing();
  if (S) {
    setText($('#abVersion'), S.version || '--');
    setText($('#abDevice'), S.device_id || '--');
  }
  if (settings) {
    setText($('#abHost'), (settings.jointspace && settings.jointspace.host) || '--');
    setText($('#abAuth'), settings.token_set ? 'A token is required to use this dashboard.' : 'Open: no access token is set.');
  }
}

function renderPairing() {
  if (!settings) return;
  const js = settings.jointspace || {};
  const paired = S ? !!S.tv.paired : !!js.paired;
  const pill = $('#pairPill');
  pill.textContent = pairStep === 'pin' ? 'Waiting for PIN' : paired ? 'Paired' : 'Not paired';
  pill.className = 'pill ' + (paired && pairStep !== 'pin' ? 'good' : 'warn');
  $('#pairIdle').hidden = pairStep === 'pin';
  $('#pairPinForm').hidden = pairStep !== 'pin';
  $('#secretField').hidden = !!js.has_app_secret;
  $('#pairForget').hidden = !paired;
  $('#pairStart').textContent = paired ? 'Pair again' : 'Start pairing';
  setText($('#pairHint'), paired ? 'The dashboard can control this TV.' : 'Pairing lets Cactarium send commands to the TV.');
}

function initServer() {
  $('#pairStart').addEventListener('click', async () => {
    const body = {};
    const sec = $('#appSecret').value.trim();
    if (sec) body.app_secret = sec;
    if (!sec && settings && !settings.jointspace.has_app_secret) { toast('Enter the app secret first'); return; }
    if (await cmdSoft('/api/pair/start', body)) {
      $('#appSecret').value = '';
      pairStep = 'pin';
      $('#pairPin').value = '';
      renderPairing();
      $('#pairPin').focus();
    }
  });
  $('#pairHavePin').addEventListener('click', () => { pairStep = 'pin'; renderPairing(); $('#pairPin').focus(); });
  $('#pairCancel').addEventListener('click', () => { pairStep = 'idle'; renderPairing(); });
  $('#pairPinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('#pairPin').value.trim();
    if (!pin) return;
    if (await cmdSoft('/api/pair/finish', { pin })) {
      pairStep = 'idle';
      toast('Paired', false);
      await loadSettings();
    }
  });
  $('#pairForget').addEventListener('click', async () => {
    if (!confirm('Forget the pairing? The TV will stop accepting commands until paired again.')) return;
    if (await cmdSoft('/api/pair/forget')) { pairStep = 'idle'; await loadSettings(); }
  });

  $('#tokenBtn').addEventListener('click', askToken);
  $('#tokenDlg').addEventListener('close', () => {
    if ($('#tokenDlg').returnValue === 'ok') {
      const v = $('#tokenInput').value.trim();
      if (v) store.set(TOKEN_KEY, v); else store.del(TOKEN_KEY);
      pollState();
      if (activeTab === 'server') loadSettings();
    }
  });
}
