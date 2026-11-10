// Cactarium dashboard, structured after Glasshouse's ui/ scripts (MIT, Copyright (c) 2026 Rory Gallagher).
'use strict';
// The MQTT tab: the broker and the Home Assistant topics.

function initMqtt() {
  const en = $('#mqEnabled');
  en.addEventListener('click', () => { en.setAttribute('aria-pressed', en.getAttribute('aria-pressed') !== 'true'); paintMqttToggle(); });
  $('#mqttForm').addEventListener('submit', async e => {
    e.preventDefault();
    const mqtt = {
      enabled: $('#mqEnabled').getAttribute('aria-pressed') === 'true',
      host: $('#mqHost').value.trim(),
      port: Number($('#mqPort').value) || 1883,
      user: $('#mqUser').value.trim(),
      prefix: $('#mqPrefix').value.trim(),
      discovery_prefix: $('#mqDisc').value.trim(),
      interval: Number($('#mqInterval').value) || 10,
    };
    const pass = $('#mqPass').value;
    if (pass) mqtt.pass = pass;
    await saveSettings({ mqtt });
  });
}

function paintMqttToggle() {
  const b = $('#mqEnabled');
  setPill(b, b.getAttribute('aria-pressed') === 'true', ['MQTT bridge: on', 'MQTT bridge: off']);
}

function renderMqtt() {
  if (!settings) return;
  const m = settings.mqtt || {};
  $('#mqEnabled').setAttribute('aria-pressed', !!m.enabled);
  paintMqttToggle();
  $('#mqHost').value = m.host || '';
  $('#mqPort').value = m.port || 1883;
  $('#mqUser').value = m.user || '';
  $('#mqPass').value = '';
  setText($('#mqPassHint'), m.has_pass ? 'A password is saved. Leave blank to keep it.' : '');
  $('#mqPrefix').value = m.prefix || 'cactarium';
  $('#mqDisc').value = m.discovery_prefix || 'homeassistant';
  $('#mqInterval').value = m.interval || 10;
  setText($('#mqttBrokerName'), m.host ? m.host + ':' + (m.port || 1883) : 'No broker set');
  renderMqttStatus();
}

function renderMqttStatus() {
  const m = (S && S.mqtt) || {};
  setText($('#mqttStatus'), !m.enabled ? 'MQTT is off.' : m.connected ? 'Connected to the broker.' : 'Not connected' + (m.error ? ': ' + m.error : '.'));
  $('#mqttDot').className = 'mqtt-dot ' + (!m.enabled ? 'idle' : m.connected ? 'good' : 'bad');
}
