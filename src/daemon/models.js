// Wire model ids shared with the Hypit provider → Flow menu labels (docs/capabilities.md).
export const WIRE_MODELS = Object.freeze({
  'nano-banana-2': { kind: 'image', flowName: 'Nano Banana 2' },
  'nano-banana-pro': { kind: 'image', flowName: 'Nano Banana Pro' },
  'nano-banana-2-lite': { kind: 'image', flowName: 'Nano Banana 2 Lite' },
  'veo-3.1-lite': { kind: 'video', flowName: 'Veo 3.1 - Lite' },
  'veo-3.1-fast': { kind: 'video', flowName: 'Veo 3.1 - Fast' },
  'veo-3.1-quality': { kind: 'video', flowName: 'Veo 3.1 - Quality' },
  'omni-flash': { kind: 'video', flowName: 'Omni 1.1 Flash' },
});

export const ASPECT_RATIOS = Object.freeze({
  image: ['16:9', '4:3', '1:1', '3:4', '9:16'],
  video: ['16:9', '9:16'],
});
