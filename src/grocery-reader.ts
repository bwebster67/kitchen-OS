import { BarcodeFormat, DecodeHintType, MultiFormatOneDReader, NotFoundException, OneDReader, Result, ResultPoint } from '@zxing/library'
import type { BitArray } from '@zxing/library'
import { normalizeBarcode } from './barcode'

const startGuard = Int32Array.of(1, 1, 1)
const endGuard = Int32Array.of(1, 1, 1, 1, 1, 1)
const oddDigits = [
  [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
  [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
]
const digitWidths = [...oddDigits, ...oddDigits.map((widths) => [...widths].reverse())]
  .map((widths) => Int32Array.from(widths))
// UPC-E encodes its number system and check digit in the six digit parities.
const zeroSystemParity = [0x38, 0x34, 0x32, 0x31, 0x2c, 0x26, 0x23, 0x2a, 0x29, 0x25]
const sum = (widths: Int32Array) => widths.reduce((total, width) => total + width, 0)
const standardHints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.UPC_A, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
]]])

export class GroceryReader extends OneDReader {
  private readonly reader = new MultiFormatOneDReader(standardHints)

  decodeRow(rowNumber: number, row: BitArray) {
    try {
      return this.reader.decodeRow(rowNumber, row, standardHints)
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error
      // The installed ZXing JS UPC-E implementation loses its decoded digits.
      return this.decodeUpce(rowNumber, row)
    }
  }

  private decodeUpce(rowNumber: number, row: BitArray) {
    const startWidths = new Int32Array(startGuard.length)
    const widths = new Int32Array(4)
    const endWidths = new Int32Array(endGuard.length)

    for (let start = row.getNextSet(0); start < row.getSize(); start = row.getNextSet(row.getNextUnset(start))) {
      GroceryReader.recordPattern(row, start, startWidths)
      const guardWidth = sum(startWidths)
      if (start < guardWidth || !row.isRange(start - guardWidth, start, false)
        || GroceryReader.patternMatchVariance(startWidths, startGuard, 0.7) >= 0.48) continue

      let end = start + guardWidth
      let digits = ''
      let parity = 0
      for (let index = 0; index < 6; index++) {
        GroceryReader.recordPattern(row, end, widths)
        let match = -1
        let variance = 0.48
        for (const [candidate, pattern] of digitWidths.entries()) {
          const difference = GroceryReader.patternMatchVariance(widths, pattern, 0.7)
          if (difference < variance) { variance = difference; match = candidate }
        }
        if (match < 0) break
        digits += match % 10
        parity = (parity << 1) | Number(match >= 10)
        end += sum(widths)
      }
      if (digits.length !== 6 || row.get(end)) continue
      GroceryReader.recordPattern(row, end, endWidths)
      const endWidth = sum(endWidths)
      const quietEnd = end + 2 * endWidth
      if (GroceryReader.patternMatchVariance(endWidths, endGuard, 0.7) >= 0.48
        || quietEnd > row.getSize() || !row.isRange(end + endWidth, quietEnd, false)) continue

      const zeroCheck = zeroSystemParity.indexOf(parity)
      const check = zeroCheck >= 0 ? zeroCheck : zeroSystemParity.indexOf(parity ^ 0x3f)
      if (check < 0) continue
      const code = `${zeroCheck >= 0 ? 0 : 1}${digits}${check}`
      const gtin = normalizeBarcode(code, 'UPC_E')
      const weighted = [...gtin].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0)
      if (weighted % 10 !== 0) continue
      return new Result(code, new Uint8Array(), 0, [new ResultPoint(start, rowNumber), new ResultPoint(end + endWidth, rowNumber)], BarcodeFormat.UPC_E)
    }
    throw new NotFoundException()
  }
}
