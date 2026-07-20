import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { print("usage: ocr <image...>"); exit(1) }

for path in args.dropFirst() {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("load fail: \(path)\n".data(using:.utf8)!); continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLanguages = ["ja-JP", "en-US"]
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { continue }
    print("===== \(path) =====")
    guard let obs = req.results else { continue }
    // sort top-to-bottom, then left-to-right
    let sorted = obs.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.008 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    for o in sorted {
        if let c = o.topCandidates(1).first { print(c.string) }
    }
}
