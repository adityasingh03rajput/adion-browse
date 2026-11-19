(function(env){const voiceSubtitleBar = env.bar, voiceSubtitleText = env.text, voiceSubtitleLabel = env.label;let voiceSubtitleHideTimer = null;let voiceSubtitleFinalAt = 0;
function showVoiceSubtitle(text, opts = {}
function hideVoiceSubtitle() {
    if (voiceSubtitleHideTimer) { clearTimeout(voiceSubtitleHideTimer); voiceSubtitleHideTimer = null; }
    if (voiceSubtitleBar) voiceSubtitleBar.classList.remove('visible', 'interim', 'listening');
  }
function showListeningSubtitle() {
    if (Date.now() - voiceSubtitleFinalAt < 2500) return;
    showVoiceSubtitle('Listening…', { listening: true, label: 'MIC', sticky: true });
  }
return { show: showVoiceSubtitle, hide: hideVoiceSubtitle, listen: showListeningSubtitle, snapshot: () => ({ visible: voiceSubtitleBar.classList.contains('visible'), interim: voiceSubtitleBar.classList.contains('interim'), listening: voiceSubtitleBar.classList.contains('listening'), text: voiceSubtitleText.textContent }), ageFinal: (ms) => { voiceSubtitleFinalAt = Date.now() - ms; } }; })