import { TelegramNotifier } from '../src/infrastructure/notifications/TelegramNotifier.js';

const notifier = new TelegramNotifier();

await notifier.onCallEnded({
  callerNumber: '+39123456789',
  durationMs: 47000,
  transcript: [
    { role: 'assistant', content: 'Salve, ha raggiunto il telefono di Ermir. Al momento non è disponibile — posso prendere il suo nome e messaggio così lui la richiama?' },
    { role: 'user', content: 'Ciao, sono Marco. Dite ad Ermir di richiamarmi.' },
    { role: 'assistant', content: 'Certamente. Vuole lasciare un numero diverso da quello da cui sta chiamando?' },
    { role: 'user', content: 'No, va bene questo.' },
    { role: 'assistant', content: 'Perfetto. Ho preso nota: Marco chiede di essere richiamato. Arrivederci!' },
  ],
});
