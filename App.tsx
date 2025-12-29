import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SYSTEM_INSTRUCTION, GEMINI_MODEL } from './constants';
import { TranscriptEntry } from './types';
import { encodeAudio, decodeAudio, decodeAudioData } from './services/audioService';
import AudioVisualizer from './components/AudioVisualizer';

type AccentColor = 'blue' | 'emerald' | 'purple' | 'amber';
type VoiceGender = 'Male' | 'Female';

const App: React.FC = () => {
  // State initialization with Persistence
  const [isRecording, setIsRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>(() => {
    try {
      const saved = localStorage.getItem('edutranslate_history');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to load history", e);
      return [];
    }
  });
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('edutranslate_theme') as 'light' | 'dark') || 'light';
  });
  const [accentColor, setAccentColor] = useState<AccentColor>(() => {
    return (localStorage.getItem('edutranslate_accent') as AccentColor) || 'blue';
  });
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(() => {
    return (localStorage.getItem('edutranslate_voice_gender') as VoiceGender) || 'Female';
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs for transcription accumulation to avoid stale closures in callbacks
  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');

  // Persistence Sync
  useEffect(() => {
    localStorage.setItem('edutranslate_history', JSON.stringify(transcripts));
  }, [transcripts]);

  useEffect(() => {
    localStorage.setItem('edutranslate_theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('edutranslate_accent', accentColor);
  }, [accentColor]);

  useEffect(() => {
    localStorage.setItem('edutranslate_voice_gender', voiceGender);
  }, [voiceGender]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [transcripts, currentInput, currentOutput]);

  const accentClasses = useMemo(() => ({
    blue: { bg: 'bg-blue-600', text: 'text-blue-600', border: 'border-blue-600', lightBg: 'bg-blue-50', darkText: 'dark:text-blue-400', soft: 'bg-blue-600/10' },
    emerald: { bg: 'bg-emerald-600', text: 'text-emerald-600', border: 'border-emerald-600', lightBg: 'bg-emerald-50', darkText: 'dark:text-emerald-400', soft: 'bg-emerald-600/10' },
    purple: { bg: 'bg-purple-600', text: 'text-purple-600', border: 'border-purple-600', lightBg: 'bg-purple-50', darkText: 'dark:text-purple-400', soft: 'bg-purple-600/10' },
    amber: { bg: 'bg-amber-600', text: 'text-amber-600', border: 'border-amber-600', lightBg: 'bg-amber-50', darkText: 'dark:text-amber-400', soft: 'bg-amber-600/10' }
  }), []);

  const activeAccent = accentClasses[accentColor];

  const saveToHistory = useCallback(() => {
    const input = currentInputRef.current;
    const output = currentOutputRef.current;
    if (input.trim() || output.trim()) {
      setTranscripts(prev => [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        text: input,
        translation: output,
        sourceLang: input.match(/[\u0E00-\u0E7F]/) ? 'Thai' : 'Chinese',
        role: 'Professor'
      }]);
    }
    currentInputRef.current = '';
    currentOutputRef.current = '';
    setCurrentInput('');
    setCurrentOutput('');
  }, []);

  const stopSession = useCallback(() => {
    saveToHistory();
    setIsRecording(false);
    setStatus('idle');
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextInRef.current) {
      audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      audioContextOutRef.current.close().catch(() => {});
      audioContextOutRef.current = null;
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, [saveToHistory]);

  const startSession = async () => {
    try {
      setStatus('connecting');
      setErrorMessage('');
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctxIn = new AudioContext({ sampleRate: 16000 });
      const ctxOut = new AudioContext({ sampleRate: 24000 });
      audioContextInRef.current = ctxIn;
      audioContextOutRef.current = ctxOut;

      await ctxOut.resume();

      // Map gender choice to Gemini prebuilt voice
      const apiVoiceName = voiceGender === 'Male' ? 'Puck' : 'Kore';

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: apiVoiceName } }
          }
        },
        callbacks: {
          onopen: () => {
            setStatus('listening');
            setIsRecording(true);
            const source = ctxIn.createMediaStreamSource(stream);
            const scriptProcessor = ctxIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(session => {
                if (session) session.sendRealtimeInput({
                  media: { data: encodeAudio(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(ctxIn.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              if (ctx.state === 'suspended') await ctx.resume();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decodeAudio(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
            if (msg.serverContent?.inputTranscription) {
              const text = msg.serverContent.inputTranscription.text;
              currentInputRef.current += text;
              setCurrentInput(currentInputRef.current);
            }
            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text;
              currentOutputRef.current += text;
              setCurrentOutput(currentOutputRef.current);
            }
            if (msg.serverContent?.turnComplete) {
              saveToHistory();
            }
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (err) => { 
            console.error("Live Error", err);
            setErrorMessage('Translation service error.'); 
            stopSession(); 
          },
          onclose: () => stopSession()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setErrorMessage('Microphone error or connection failed.');
      setStatus('error');
    }
  };

  const toggleRole = (id: string) => {
    setTranscripts(prev => prev.map(t => t.id === id ? { ...t, role: t.role === 'Professor' ? 'Student' : 'Professor' } : t));
  };

  const clearHistory = () => {
    if (window.confirm('Clear all transcript data?')) {
      setTranscripts([]);
      localStorage.removeItem('edutranslate_history');
    }
  };

  const exportTranscript = () => {
    const text = transcripts.map(t => `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.role}\nSource: ${t.text}\nTrans: ${t.translation}\n`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EduTranslate_Session_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleTheme = useCallback(() => setTheme(prev => (prev === 'light' ? 'dark' : 'light')), []);

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) { console.error('Failed to copy', err); }
  }, []);

  const stats = useMemo(() => ({
    count: transcripts.length,
    thaiCount: transcripts.filter(t => t.sourceLang === 'Thai').length,
    chineseCount: transcripts.filter(t => t.sourceLang === 'Chinese').length,
  }), [transcripts]);

  return (
    <div className="min-h-screen flex flex-col bg-[#F9FAFB] dark:bg-[#0B0F1A] transition-all duration-500 font-sans selection:bg-blue-100 selection:text-blue-900">
      
      {/* Header */}
      <header className="sticky top-0 z-30 w-full bg-white/80 dark:bg-[#111827]/80 backdrop-blur-xl border-b border-slate-200 dark:border-slate-800 px-6 py-3 shadow-sm">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-11 h-11 ${activeAccent.bg} rounded-2xl flex items-center justify-center text-white shadow-xl rotate-3 hover:rotate-0 transition-transform`}>
              <i className="fas fa-graduation-cap text-xl"></i>
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-slate-900 dark:text-white leading-none">EduTranslate <span className={activeAccent.text}>Live</span></h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Enterprise Academic v2.0</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-5">
            <div className="hidden lg:flex items-center gap-4 border-x border-slate-200 dark:border-slate-800 px-6">
              <div className="text-center">
                <div className="text-xs font-black text-slate-400 dark:text-slate-600 uppercase tracking-tighter">Entries</div>
                <div className="text-sm font-bold dark:text-white">{stats.count}</div>
              </div>
              <div className="text-center">
                <div className="text-xs font-black text-slate-400 dark:text-slate-600 uppercase tracking-tighter">TH ⇄ ZH</div>
                <div className="text-sm font-bold dark:text-white">{stats.thaiCount}/{stats.chineseCount}</div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Simplified Voice Selection (Male/Female) */}
              <div className="hidden sm:flex items-center bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-200 dark:border-slate-700">
                {(['Female', 'Male'] as VoiceGender[]).map((gender) => (
                  <button
                    key={gender}
                    disabled={isRecording}
                    onClick={() => setVoiceGender(gender)}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                      voiceGender === gender 
                        ? `${activeAccent.bg} text-white shadow-sm` 
                        : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                    } disabled:opacity-50`}
                  >
                    {gender === 'Female' ? <><i className="fas fa-venus mr-1.5"></i>Female</> : <><i className="fas fa-mars mr-1.5"></i>Male</>}
                  </button>
                ))}
              </div>

              <div className="hidden sm:flex items-center bg-slate-100 dark:bg-slate-800/50 p-1 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
                {(['blue', 'emerald', 'purple', 'amber'] as AccentColor[]).map((c) => (
                  <button key={c} onClick={() => setAccentColor(c)} className={`w-6 h-6 rounded-lg m-0.5 transition-all ${c === 'blue' ? 'bg-blue-500' : c === 'emerald' ? 'bg-emerald-500' : c === 'purple' ? 'bg-purple-500' : 'bg-amber-500'} ${accentColor === c ? 'ring-2 ring-offset-2 ring-slate-400 dark:ring-slate-600 scale-110 shadow-lg' : 'opacity-40 hover:opacity-100'}`} />
                ))}
              </div>

              <button onClick={toggleTheme} className="p-2.5 w-11 h-11 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                <i className={`fas ${theme === 'light' ? 'fa-moon' : 'fa-sun'}`}></i>
              </button>

              {!isRecording ? (
                <button onClick={startSession} className={`${activeAccent.bg} hover:brightness-110 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-blue-500/20 flex items-center gap-2 transition-all active:scale-95`}>
                  <i className="fas fa-microphone"></i> <span className="hidden sm:inline">Connect Live</span>
                </button>
              ) : (
                <button onClick={stopSession} className="bg-red-500 hover:bg-red-600 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-red-500/20 flex items-center gap-2 transition-all active:scale-95">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div> <span>Stop Live</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Display */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full p-4 lg:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 overflow-hidden">
        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-white dark:bg-[#111827] rounded-[2rem] p-8 shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col gap-6 relative overflow-hidden group">
            <div className={`absolute top-0 right-0 w-32 h-32 ${activeAccent.soft} rounded-full -mr-16 -mt-16 transition-all duration-700 group-hover:scale-150`}></div>
            <div className="flex items-center justify-between relative z-10">
              <h2 className="text-sm font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest">Active Processing</h2>
              {status === 'listening' && <div className="flex items-center gap-2 text-[10px] font-bold text-green-500 bg-green-500/10 px-3 py-1 rounded-full"><span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></span> Live Capturing</div>}
            </div>
            <div className="flex flex-col gap-6 relative z-10">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                   <div className={`w-6 h-6 rounded-full ${activeAccent.bg} flex items-center justify-center text-[10px] text-white shadow-lg`}><i className="fas fa-comment"></i></div>
                   <span className="text-xs font-bold text-slate-500 uppercase tracking-tighter">Detected Speech</span>
                </div>
                <div className="min-h-[120px] p-6 bg-slate-50 dark:bg-slate-900/50 rounded-3xl text-slate-800 dark:text-slate-200 text-xl font-medium leading-relaxed border border-slate-100 dark:border-slate-800 transition-all">
                  {currentInput || <span className="text-slate-300 dark:text-slate-700 italic">Waiting for voice activity...</span>}
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                   <div className="w-6 h-6 rounded-full bg-slate-800 dark:bg-slate-600 flex items-center justify-center text-[10px] text-white shadow-lg"><i className="fas fa-language"></i></div>
                   <span className="text-xs font-bold text-slate-500 uppercase tracking-tighter">Academic Translation</span>
                </div>
                <div className={`min-h-[120px] p-6 rounded-3xl text-slate-900 dark:text-white text-xl font-bold leading-relaxed border transition-all ${theme === 'dark' ? 'bg-blue-900/10 border-blue-900/30' : 'bg-blue-50/50 border-blue-100'}`}>
                  {currentOutput || <span className="text-blue-200 dark:text-blue-900/40 italic">System ready for output...</span>}
                </div>
              </div>
            </div>
            <div className="mt-4 pt-6 border-t border-slate-100 dark:border-slate-800">
               <AudioVisualizer stream={streamRef.current} isActive={isRecording} />
            </div>
          </div>
        </div>

        {/* History Column */}
        <div className="lg:col-span-7 flex flex-col bg-white dark:bg-[#111827] rounded-[2.5rem] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden">
          <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/20 backdrop-blur-sm">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-slate-900 dark:bg-slate-700 flex items-center justify-center text-white"><i className="fas fa-list-ul"></i></div>
              <div>
                <h2 className="text-lg font-black dark:text-white leading-none">Session Transcript</h2>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest mt-1">Permanent record of class dialogue</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={exportTranscript} className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:shadow-md transition-all active:scale-95" title="Export as Text">
                <i className="fas fa-file-export"></i>
              </button>
              <button onClick={clearHistory} className="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all active:scale-95" title="Clear All">
                <i className="fas fa-trash-alt"></i>
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-12 scroll-smooth bg-slate-50/20 dark:bg-transparent">
            {transcripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-300 dark:text-slate-800 gap-6 opacity-60">
                <div className="w-24 h-24 rounded-full bg-slate-100 dark:bg-slate-800/50 flex items-center justify-center text-5xl">
                  <i className="fas fa-ghost"></i>
                </div>
                <div className="text-center">
                  <p className="text-xl font-black uppercase tracking-tighter">Transcript Empty</p>
                  <p className="text-sm font-bold opacity-70">Begin speaking to generate translation history</p>
                </div>
              </div>
            ) : (
              transcripts.map((entry, idx) => (
                <div key={entry.id} className="relative group flex flex-col gap-4 animate-fadeIn">
                  {idx > 0 && <div className="absolute -top-8 left-12 w-px h-8 bg-slate-100 dark:bg-slate-800"></div>}
                  <div className="flex items-start gap-6">
                    <div className="flex flex-col items-center gap-2 pt-1">
                      <button 
                        onClick={() => toggleRole(entry.id)}
                        className={`w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg transition-all active:scale-90 ${
                          entry.role === 'Professor' ? `${activeAccent.bg} text-white shadow-blue-500/20` : 'bg-slate-800 text-white shadow-slate-900/20'
                        }`}
                        title="Switch Role"
                      >
                        <i className={`fas ${entry.role === 'Professor' ? 'fa-user-tie' : 'fa-user-graduate'}`}></i>
                      </button>
                      <span className="text-[9px] font-black uppercase text-slate-400 dark:text-slate-600 tracking-tighter">{entry.role}</span>
                    </div>
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-white dark:bg-slate-800/50 p-6 rounded-[1.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative group/bubble">
                         <div className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-2 flex justify-between">
                            <span>{entry.sourceLang === 'Thai' ? 'Source: Thai' : 'Source: Chinese'}</span>
                            <span className="opacity-0 group-hover/bubble:opacity-100 transition-opacity">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                         </div>
                         <p className="text-slate-700 dark:text-slate-300 font-medium leading-relaxed">{entry.text}</p>
                      </div>
                      <div className={`p-6 rounded-[1.5rem] border shadow-md relative group/bubble transition-all ${theme === 'dark' ? 'bg-blue-900/5 border-blue-900/20' : 'bg-blue-50/30 border-blue-100/50'}`}>
                        <div className="text-[9px] font-black text-blue-500/70 dark:text-blue-400 uppercase tracking-widest mb-2 flex justify-between items-center">
                          <span>Translation</span>
                          <button onClick={() => copyToClipboard(entry.translation, entry.id)} className="p-1 hover:text-blue-600 transition-colors">
                            <i className={`fas ${copiedId === entry.id ? 'fa-check text-green-500' : 'fa-copy'}`}></i>
                          </button>
                        </div>
                        <p className="text-slate-900 dark:text-blue-50 font-bold leading-relaxed">{entry.translation}</p>
                        {copiedId === entry.id && <span className="absolute top-0 right-12 mt-1.5 bg-slate-900 text-white text-[8px] px-2 py-1 rounded-lg animate-fadeIn z-20">Copied</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-white dark:bg-[#111827] border-t border-slate-100 dark:border-slate-800 px-8 py-4 flex flex-col md:flex-row items-center justify-between gap-4 text-slate-400 dark:text-slate-500">
        <div className="flex items-center gap-6 text-[10px] font-black uppercase tracking-widest">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span>System Active</span>
          </div>
          <span>Mode: {voiceGender} Academic Voice</span>
        </div>
        <div className="text-[9px] md:text-[10px] font-black tracking-[0.1em] md:tracking-[0.2em] uppercase text-center md:text-right">
          EduTranslate Live • Developed and Copyright © 2026 by Dr. Pattaroj Kamonrojsiri. All Rights Reserved.
        </div>
      </footer>

      {/* Notifications */}
      {errorMessage && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-red-600 text-white px-8 py-4 rounded-[1.5rem] shadow-2xl flex items-center gap-4 animate-bounce z-[100]">
          <i className="fas fa-exclamation-circle text-2xl"></i>
          <div>
            <p className="font-black uppercase text-xs tracking-widest">System Alert</p>
            <p className="text-sm font-medium opacity-90">{errorMessage}</p>
          </div>
          <button onClick={() => setErrorMessage('')} className="ml-4 p-2 hover:bg-white/10 rounded-full"><i className="fas fa-times"></i></button>
        </div>
      )}
    </div>
  );
};

export default App;
