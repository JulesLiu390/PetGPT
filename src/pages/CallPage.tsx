import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FaPhoneSlash } from 'react-icons/fa6';
import CharacterAppearance from '../components/Avatar/CharacterAppearance.jsx';
import { startSpeech, stopSpeech } from '../components/Avatar/speechLevel.ts';
import * as tauri from '../utils/tauri.js';
import { listenCallEvent, voiceCallStop, type CallSource } from '../utils/social/voiceCallApi.ts';

// Captions kept on screen, newest last.
const CAPTION_LINES = 4;

const SOURCE_LABEL: Record<CallSource, string> = { mic: 'You', system: 'Computer audio' };

interface Pet {
  name?: string;
  skinId?: string;
}

interface Caption {
  who: 'pet' | CallSource;
  text: string;
  key: string;
}

interface CallProblem {
  source: string;
  message: string;
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** The video call window: the pet's skin talks while the social workflow speaks through it. */
export default function CallPage() {
  const params = new URLSearchParams(useLocation().search);
  const callId = Number(params.get('call')) || 0;
  const petId = params.get('pet') || '';
  const targetId = params.get('target') || '';
  const targetName = params.get('name') || targetId;

  useEffect(() => {
    document.documentElement.dataset.window = 'call';
    document.body.style.background = '#0f172a';
  }, []);

  // Each call starts from a clean screen, even if this window is ever pointed at another call.
  return <CallView key={callId} callId={callId} petId={petId} targetName={targetName} />;
}

function CallView({ callId, petId, targetName }: { callId: number; petId: string; targetName: string }) {
  const [pet, setPet] = useState<Pet | null>(null);
  const [layered, setLayered] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [errors, setErrors] = useState<CallProblem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const speechId = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (tauri.getPet(petId) as Promise<Pet | null>).then(async (found) => {
      if (cancelled) return;
      setPet(found || null);
      if (!found?.skinId) { setLayered(false); return; }
      const appearance = await (tauri.getSkinAppearance(found.skinId, 'normal') as Promise<{ kind?: string } | null>)
        .catch(() => null);
      if (!cancelled) setLayered(appearance?.kind === 'layered');
    }).catch(() => { if (!cancelled) setPet(null); });
    return () => { cancelled = true; };
  }, [petId]);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // The same event twice is one caption.
    const addCaption = (caption: Caption) => setCaptions(list => (list.some(c => c.key === caption.key)
      ? list
      : [...list, caption].slice(-CAPTION_LINES)));
    // Events from every call reach every window; only this call's count here.
    const ours = (payload: { callId: number }) => payload.callId === callId;
    const subscriptions = [
      listenCallEvent('voice-call-speech', (speech) => {
        if (!ours(speech)) return;
        speechId.current = speech.id;
        startSpeech(speech);
        setSpeaking(true);
        // Talking again: the note about the last answer failing is out of date.
        setErrors(list => list.filter(e => e.source !== 'llm'));
        addCaption({ who: 'pet', text: speech.text, key: `s${speech.id}` });
      }),
      listenCallEvent('voice-call-speech-end', (end) => {
        if (!ours(end) || speechId.current !== end.id) return;
        stopSpeech();
        setSpeaking(false);
      }),
      listenCallEvent('voice-call-transcript', (heard) => {
        if (!ours(heard)) return;
        addCaption({ who: heard.source, text: heard.text, key: `h${heard.source}${heard.startedAt}` });
      }),
      listenCallEvent('voice-call-error', (problem) => {
        if (!ours(problem)) return;
        setErrors(list => [...list.filter(e => e.source !== problem.source), { source: problem.source, message: problem.message }]);
      }),
    ];
    return () => {
      stopSpeech();
      subscriptions.forEach(promise => promise.then(off => off()).catch(() => {}));
    };
  }, [callId]);

  // Hanging up an already finished call does nothing, so pressing twice is fine.
  const hangUp = () => { voiceCallStop(callId || undefined).catch(() => {}); };
  const petName = pet?.name || 'Pet';

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-900 text-slate-100 select-none overflow-hidden">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{petName}</div>
          <div className="text-xs text-slate-400 truncate">{targetName}</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-300 tabular-nums">
          <span className={`inline-block w-2 h-2 rounded-full ${speaking ? 'bg-emerald-400 animate-pulse' : 'bg-sky-400'}`} />
          <span>{speaking ? 'Speaking' : 'Listening'}</span>
          <span className="text-slate-500">{clock(elapsed)}</span>
        </div>
      </header>

      <main className="relative flex-1 mx-3 rounded-2xl overflow-hidden bg-gradient-to-b from-slate-700 to-slate-800">
        <div className="absolute inset-x-0 top-4 bottom-0">
          {pet && <CharacterAppearance skinId={pet.skinId} mood="normal" />}
        </div>
        {pet && !layered && (
          <div className="absolute top-2 inset-x-2 text-center text-[11px] text-amber-200 bg-black/40 rounded px-2 py-1">
            Lip sync works with layered skins only
          </div>
        )}
        <div className="absolute inset-x-2 bottom-2 space-y-1">
          {captions.map(caption => (
            <div key={caption.key} className={`text-xs leading-snug rounded-lg px-2 py-1 backdrop-blur-sm ${caption.who === 'pet' ? 'bg-emerald-900/60' : 'bg-black/50'}`}>
              <span className="text-slate-400 mr-1">{caption.who === 'pet' ? petName : SOURCE_LABEL[caption.who]}:</span>
              {caption.text}
            </div>
          ))}
        </div>
      </main>

      {errors.length > 0 && (
        <div className="mx-3 mt-2 space-y-1">
          {errors.map(error => (
            <div key={error.source} className="text-[11px] text-rose-300 bg-rose-950/60 rounded px-2 py-1 break-words">{error.message}</div>
          ))}
        </div>
      )}

      <footer className="flex justify-center py-4">
        <button
          type="button"
          onClick={hangUp}
          title="Hang up"
          className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-500 flex items-center justify-center shadow-lg"
        >
          <FaPhoneSlash className="w-6 h-6" />
        </button>
      </footer>
    </div>
  );
}
