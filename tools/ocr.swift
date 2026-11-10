import Foundation
import Vision
import AppKit

// usage:
//   ocr <image...>            テキストのみを上から順に出力
//   ocr --bbox <image...>     text<TAB>x0<TAB>y0<TAB>x1<TAB>y1 を画素座標で出力
//                             （原点は左上。figcrop.py がこの座標で図を切り出す）

var args = Array(CommandLine.arguments.dropFirst())
var bboxMode = false
if let i = args.firstIndex(of: "--bbox") {
    bboxMode = true
    args.remove(at: i)
}
guard !args.isEmpty else {
    print("usage: ocr [--bbox] <image...>")
    exit(1)
}

for path in args {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("load fail: \(path)\n".data(using: .utf8)!)
        continue
    }
    let w = CGFloat(cg.width), h = CGFloat(cg.height)

    let req = VNRecognizeTextRequest()
    req.recognitionLanguages = ["ja-JP", "en-US"]
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { continue }

    print("===== \(path) =====")
    guard let obs = req.results else { continue }

    // 上から下、次に左から右
    let sorted = obs.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.008 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }

    for o in sorted {
        guard let c = o.topCandidates(1).first else { continue }
        if bboxMode {
            // Vision は左下原点の正規化座標。左上原点の画素座標へ変換する。
            let b = o.boundingBox
            let x0 = Int((b.minX * w).rounded())
            let x1 = Int((b.maxX * w).rounded())
            let y0 = Int(((1 - b.maxY) * h).rounded())
            let y1 = Int(((1 - b.minY) * h).rounded())
            let text = c.string.replacingOccurrences(of: "\t", with: " ")
            print("\(text)\t\(x0)\t\(y0)\t\(x1)\t\(y1)")
        } else {
            print(c.string)
        }
    }
}
