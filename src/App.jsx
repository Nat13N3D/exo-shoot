import { useState } from 'react';
import PinEntry from './components/PinEntry.jsx';
import CameraCapture from './components/CameraCapture.jsx';
import ClipPreview from './components/ClipPreview.jsx';

export default function App() {
  const [pin, setPin] = useState(null);
  const [pendingClip, setPendingClip] = useState(null);

  if (!pin) {
    return <PinEntry onConnect={(p) => setPin(p)} />;
  }

  if (pendingClip) {
    return (
      <ClipPreview
        clip={pendingClip}
        pin={pin}
        onRetake={() => setPendingClip(null)}
        onSent={() => setPendingClip(null)}
      />
    );
  }

  return (
    <CameraCapture
      pin={pin}
      onClipRecorded={(clip) => setPendingClip(clip)}
      onSignOut={() => setPin(null)}
    />
  );
}
