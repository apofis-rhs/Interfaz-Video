import type { ChangeEvent } from 'react'
import type { ProviderSource } from '../api/types'
import { SOURCE_LABELS } from '../utils/sourceValidation'

const PROVIDER_SOURCES: ProviderSource[] = ['google_drive', 'onedrive', 'dropbox']

interface Props {
  disabled: boolean
  onPickLocal: (file: File) => void
  onPickProvider: (source: ProviderSource) => void
  onPickYoutube: () => void
}

export function SourcePicker({ disabled, onPickLocal, onPickProvider, onPickYoutube }: Props) {
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onPickLocal(file)
  }

  return (
    <div className="source-picker">
      <label className={`button button--source${disabled ? ' button--disabled' : ''}`}>
        Local
        <input type="file" accept="video/*" onChange={handleFileChange} disabled={disabled} hidden />
      </label>

      {PROVIDER_SOURCES.map((source) => (
        <button
          key={source}
          type="button"
          className="button button--source"
          disabled={disabled}
          onClick={() => onPickProvider(source)}
        >
          {SOURCE_LABELS[source]}
        </button>
      ))}

      <button type="button" className="button button--source" disabled={disabled} onClick={onPickYoutube}>
        {SOURCE_LABELS.youtube}
      </button>
    </div>
  )
}
