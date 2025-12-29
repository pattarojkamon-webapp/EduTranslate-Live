
export interface TranscriptEntry {
  id: string;
  timestamp: number;
  text: string;
  translation: string;
  sourceLang: 'Thai' | 'Chinese';
  role: 'Professor' | 'Student';
}

export type LanguageMode = 'TH_TO_ZH' | 'ZH_TO_TH';

export interface AudioConfig {
  sampleRate: number;
  channels: number;
}
