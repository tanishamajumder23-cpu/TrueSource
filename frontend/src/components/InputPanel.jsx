import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageIcon, LinkIcon, TextIcon, UploadIcon, VideoIcon, XIcon } from './Icons';

/**
 * The input surface: four modes behind one panel.
 *
 * Tabs (rather than four separate pages) because they are all the same verb —
 * "check this" — applied to different media. Switching modes must never lose
 * what you already typed, so each mode keeps its own state.
 */

const TABS = [
  { id: 'text', label: 'Text', Icon: TextIcon },
  { id: 'url', label: 'URL', Icon: LinkIcon },
  { id: 'image', label: 'Image', Icon: ImageIcon },
  { id: 'video', label: 'Video', Icon: VideoIcon },
];

/** Human-readable file size for the preview bar. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A drag-and-drop zone with click-to-browse and an inline preview.
 * Used for both images and video, differing only in accept type and preview tag.
 */
function DropZone({ accept, file, onFile, onClear, kind, disabled }) {
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const inputRef = useRef(null);

  // Object URLs are a memory leak if you never revoke them, so the preview URL
  // is tied to the file's lifetime.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const dropped = event.dataTransfer.files?.[0];
      if (dropped) onFile(dropped);
    },
    [disabled, onFile],
  );

  if (file && previewUrl) {
    return (
      <div className="file-preview">
        {kind === 'image' ? (
          <img src={previewUrl} alt="Selected screenshot preview" />
        ) : (
          // Controls let the user scrub to check they picked the right clip.
          <video src={previewUrl} controls preload="metadata" />
        )}
        <div className="file-preview__bar">
          <span className="file-preview__name">
            {file.name} · {formatBytes(file.size)}
          </span>
          <button type="button" className="icon-button" onClick={onClear} disabled={disabled} aria-label="Remove file">
            <XIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      // Keyboard parity: a div acting as a button must behave like one.
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-disabled={disabled}
    >
      <UploadIcon className="dropzone__icon" width={26} height={26} />
      <span className="dropzone__title">
        Drop {kind === 'image' ? 'a screenshot' : 'a video or audio file'} here
      </span>
      <span className="dropzone__hint">
        or click to browse ·{' '}
        {kind === 'image' ? 'PNG, JPG, WebP up to 10 MB' : 'MP4, MOV, WebM, MP3 up to 200 MB'}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) onFile(picked);
          // Reset so picking the same file twice still fires a change event.
          event.target.value = '';
        }}
      />
    </div>
  );
}

export function InputPanel({ mode, onModeChange, values, onChange, onSubmit, onCancel, isRunning, uploadProgress }) {
  const { text, url, imageFile, videoFile } = values;

  // Is there anything to submit in the current mode?
  const canSubmit =
    (mode === 'text' && text.trim().length > 8) ||
    (mode === 'url' && /^https?:\/\/\S+$/i.test(url.trim())) ||
    (mode === 'image' && Boolean(imageFile)) ||
    (mode === 'video' && Boolean(videoFile));

  return (
    <section className="panel" aria-label="Submit content to fact-check">
      <div className="tabs" role="tablist" aria-label="Input type">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={mode === id}
            onClick={() => onModeChange(id)}
            disabled={isRunning}
          >
            <Icon width={15} height={15} />
            {label}
          </button>
        ))}
      </div>

      {/* Keying the body on `mode` replays the fade so a tab switch feels intentional. */}
      <div className="input-body" key={mode}>
        {mode === 'text' && (
          <>
            <textarea
              className="textarea"
              placeholder="Paste a claim, a paragraph, a tweet, a forwarded message..."
              value={text}
              onChange={(event) => onChange('text', event.target.value)}
              disabled={isRunning}
              // Ctrl/Cmd+Enter submits — the shortcut people already expect.
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) onSubmit();
              }}
            />
            <div className="input-hint">
              <span>Each factual claim is checked separately against live web evidence.</span>
              <span>{text.length} characters</span>
            </div>
          </>
        )}

        {mode === 'url' && (
          <>
            <input
              className="text-input"
              type="url"
              inputMode="url"
              placeholder="https://example.com/news/article"
              value={url}
              onChange={(event) => onChange('url', event.target.value)}
              disabled={isRunning}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) onSubmit();
              }}
            />
            <div className="input-hint">
              <span>The article is fetched and stripped to clean text before any claim is extracted.</span>
            </div>
          </>
        )}

        {mode === 'image' && (
          <>
            <DropZone
              kind="image"
              accept="image/*"
              file={imageFile}
              onFile={(file) => onChange('imageFile', file)}
              onClear={() => onChange('imageFile', null)}
              disabled={isRunning}
            />
            <div className="input-hint">
              <span>Screenshot a post from X, Instagram, LinkedIn or WhatsApp — the text is read straight off it.</span>
            </div>
          </>
        )}

        {mode === 'video' && (
          <>
            <DropZone
              kind="video"
              accept="video/*,audio/*"
              file={videoFile}
              onFile={(file) => onChange('videoFile', file)}
              onClear={() => onChange('videoFile', null)}
              disabled={isRunning}
            />
            {isRunning && uploadProgress > 0 && uploadProgress < 100 && (
              <>
                <div className="progress">
                  <div className="progress__fill" style={{ width: `${uploadProgress}%` }} />
                </div>
                <div className="input-hint">
                  <span>Uploading… {uploadProgress}%</span>
                </div>
              </>
            )}
            {!isRunning && (
              <div className="input-hint">
                <span>Audio is transcribed in chunks, so verdicts appear while the rest is still processing.</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="action-bar">
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {mode === 'text' ? 'Tip: press ⌘/Ctrl + Enter to run' : 'Evidence is retrieved live — nothing is answered from memory.'}
        </span>

        {isRunning ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled>
              <span className="spinner" />
              Checking…
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onSubmit} disabled={!canSubmit}>
            Analyze
          </button>
        )}
      </div>
    </section>
  );
}
