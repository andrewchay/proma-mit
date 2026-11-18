import * as React from 'react'

interface DesignPreview { assetId: string; dataUrl: string }

export function DirectorDesignPreview({ draftId, revision, onPrepare }: { draftId: string; revision: number; onPrepare: (assetId: string | null) => Promise<void> }): React.ReactElement {
  const [preview, setPreview] = React.useState<DesignPreview | null>(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [preparing, setPreparing] = React.useState(false)
  React.useEffect(() => {
    let active = true
    setPreview(null)
    setLoading(true)
    setError('')
    void window.electronAPI.paa.newMedia.content.getDirectorDesignPreview(draftId)
      .then(value => { if (active) setPreview(value) })
      .catch(() => { if (active) setError('设计素材读取失败，请返回总监对话重新制作。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [draftId, revision])
  const prepare = async (): Promise<void> => {
    setPreparing(true)
    setError('')
    try { await onPrepare(preview?.assetId ?? null) }
    catch (error) { setError(error instanceof Error ? error.message : '准备交接失败') }
    finally { setPreparing(false) }
  }
  return <div className="mt-3">
    {preview && <><img src={preview.dataUrl} alt="待审核的封面设计" className="max-h-96 rounded-lg object-contain" /><p className="mt-1 text-xs text-foreground/50">封面预览；交付包包含 PNG 和可编辑 SVG。</p></>}
    {!loading && !error && !preview && <p className="text-xs text-amber-700 dark:text-amber-300">尚无封面，交接后需在发布端补充。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <button disabled={loading || preparing || Boolean(error)} onClick={() => void prepare()} className="mt-2 text-xs text-primary hover:underline disabled:opacity-50">{loading ? '正在读取封面…' : preparing ? '正在准备…' : '准备官方发布交接'}</button>
  </div>
}
