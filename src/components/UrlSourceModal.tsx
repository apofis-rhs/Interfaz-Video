import { useState, type FormEvent } from 'react'
import type { RemoteSource } from '../api/types'
import { SOURCE_LABELS, validateSourceUrl } from '../utils/sourceValidation'

interface Props {
  source: RemoteSource
  onCancel: () => void
  onSubmit: (url: string) => void
}

export function UrlSourceModal({ source, onCancel, onSubmit }: Props) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const validationError = validateSourceUrl(source, url)
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(url.trim())
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Importar desde {SOURCE_LABELS[source]}</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="url"
            placeholder={`Pega el enlace de ${SOURCE_LABELS[source]}`}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setError(null)
            }}
            autoFocus
          />
          {error && <p className="modal__error">{error}</p>}
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={onCancel}>
              Cancelar
            </button>
            <button type="submit" className="button button--primary">
              Importar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
