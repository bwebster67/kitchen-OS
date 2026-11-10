import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ScanBarcode } from 'lucide-react'
import { Link } from 'react-router'
import { useKitchen } from './context'
import { lookupProduct, normalizeBarcode } from './barcode'
import type { BarcodeFormat, ProductMatch } from './barcode'
import { Alert, Button, Field, PageTitle, errorMessage } from './ui'
import { GroceryForm } from './Inventory'

type Scan = { barcode: string; product: ProductMatch | null; message: string }

export function Scanner() {
  const { kitchen } = useKitchen()
  const [manual, setManual] = useState('')
  const [format, setFormat] = useState<BarcodeFormat>('GTIN')
  const [error, setError] = useState('')
  const [camera, setCamera] = useState(false)
  const [pending, setPending] = useState(false)
  const [scan, setScan] = useState<Scan | null>(null)
  const occupied = useRef(false)
  const run = useRef(0)
  const video = useRef<HTMLVideoElement>(null)
  const handleScan = useRef<(input: string, format: BarcodeFormat) => boolean>(() => false)

  function detect(input: string, source: BarcodeFormat) {
    if (occupied.current) return false
    let barcode
    try { barcode = normalizeBarcode(input, source) }
    catch (error) { setError(errorMessage(error)); return false }
    occupied.current = true
    const request = ++run.current
    setError('')
    setPending(true)
    setCamera(false)
    void lookupProduct(barcode, kitchen.products).then((result) => {
      if (request !== run.current) return
      setPending(false)
      setScan({ barcode, ...result })
    })
    return true
  }
  handleScan.current = detect
  useEffect(() => () => { run.current += 1 }, [])

  useEffect(() => {
    if (!camera) return
    let stopped = false
    let stream: MediaStream | undefined
    let controls: { stop: () => void } | undefined
    const element = video.current
    function stop() {
      stopped = true
      controls?.stop()
      stream?.getTracks().forEach((track) => track.stop())
      if (element) element.srcObject = null
    }
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !element) throw new Error('Camera scanning requires a supported browser over HTTPS. Enter the barcode below.')
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (stopped) { stream.getTracks().forEach((track) => track.stop()); return }
        const [{ BrowserCodeReader }, { BarcodeFormat: ZXFormat }, { GroceryReader }] = await Promise.all([
          import('@zxing/browser'), import('@zxing/library'), import('./grocery-reader'),
        ])
        if (stopped) return
        const formats: Record<number, BarcodeFormat> = {
          [ZXFormat.UPC_A]: 'UPC_A', [ZXFormat.UPC_E]: 'UPC_E', [ZXFormat.EAN_13]: 'EAN_13', [ZXFormat.EAN_8]: 'EAN_8',
        }
        const reader = new BrowserCodeReader(new GroceryReader())
        controls = await reader.decodeFromStream(stream, element, (result, _error, active) => {
          const format = result && formats[result.getBarcodeFormat()]
          if (!stopped && result && format && handleScan.current(result.getText(), format)) {
            active.stop()
            stop()
          }
        })
        if (stopped) controls.stop()
      } catch (error) {
        if (stopped) return
        stop()
        setCamera(false)
        const name = error instanceof Error ? error.name : ''
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was denied. Allow camera access in your browser or enter the barcode below.'
          : name === 'NotFoundError' || name === 'NotReadableError'
            ? 'No available camera was found. Enter the barcode below.'
            : errorMessage(error))
      }
    }
    void start()
    return stop
  }, [camera])

  function reset() {
    run.current += 1
    occupied.current = false
    setScan(null)
    setManual('')
    setError('')
    setPending(false)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    detect(manual, format)
  }

  return <>
    <PageTitle label="Grocery intake" title={scan ? 'Review grocery' : 'Scan a barcode'} action={<Link className="button secondary" to="/kitchen/add">Manual grocery entry</Link>}>
      {scan ? 'Confirm the package count, storage location and any dates on the label.' : 'Point your camera at a grocery barcode or type the digits below.'}
    </PageTitle>
    {error && <Alert>{error}</Alert>}
    {pending ? <section className="card" role="status">Looking up the product…</section> : scan ? <>
      <Alert kind="info">{scan.message} {scan.product?.source === 'open_food_facts' &&
        <a className="underline" href={`https://world.openfoodfacts.org/product/${scan.barcode}`} target="_blank" rel="noreferrer">Open Food Facts (ODbL)</a>}</Alert>
      <GroceryForm key={scan.barcode} barcode={scan.barcode} product={scan.product} onSaved={reset} submitLabel="Add and scan another" />
      <div><Button variant="quiet" onClick={reset}>Cancel review</Button></div>
    </> : <>
      <section className="card stack">
        {camera ? <>
          <div className="camera"><video ref={video} autoPlay muted playsInline aria-label="Barcode scanner camera preview" /><div className="scan-target" aria-hidden="true" /></div>
          <Button variant="secondary" onClick={() => setCamera(false)}>Stop camera</Button>
        </> : <div className="scanner-start"><ScanBarcode size={38} aria-hidden="true" /><Button onClick={() => { setError(''); setCamera(true) }}>Open camera</Button></div>}
      </section>
      <form className="card stack" onSubmit={submit}>
        <h2>Enter the digits</h2>
        <div className="form-grid">
          <Field label="Barcode"><input value={manual} onChange={(event) => setManual(event.target.value)} inputMode="numeric" pattern="[0-9]{8,14}" maxLength={14} required /></Field>
          <Field label="Barcode format"><select value={format} onChange={(event) => setFormat(event.target.value as BarcodeFormat)}><option value="GTIN">UPC / EAN / GTIN</option><option value="UPC_E">UPC-E (short UPC)</option></select></Field>
        </div>
        <div><Button type="submit">Look up barcode</Button></div>
      </form>
    </>}
    <small>Product lookup by <a className="underline" href="https://world.openfoodfacts.org/" target="_blank" rel="noreferrer">Open Food Facts</a> under the <a className="underline" href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">Open Database License</a>.</small>
  </>
}
