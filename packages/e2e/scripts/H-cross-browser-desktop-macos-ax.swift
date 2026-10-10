// Area H macOS accessibility helper for the desktop smoke.
//
// The release app has no DOM access, so the smoke reads and drives the app
// through the macOS accessibility tree. Built at run time into the run's
// owner-only directory by scripts/desktop-smoke-macos.sh:
//   swiftc -O -o <run>/bin/ax packages/e2e/scripts/H-cross-browser-desktop-macos-ax.swift
//
// Secret handling: `type` reads its text from stdin (never argv), types it into
// the focused field and prints nothing about it. `snapshot` never returns text
// field values, and returns no static text at all while a guard label applies
// (a password being typed, a phrase grid, a recovery phrase screen).
//
// Every command prints one JSON object on stdout.
import ApplicationServices
import Cocoa

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(2)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String { (attribute(element, name) as? String) ?? "" }

struct Node {
    let element: AXUIElement
    let role: String
    let subrole: String
    let label: String
    let value: String
}

func app(_ pidText: String) -> (AXUIElement, pid_t) {
    guard let pid = pid_t(pidText) else { fail("bad pid") }
    return (AXUIElementCreateApplication(pid), pid)
}

func mainWindow(_ application: AXUIElement) -> AXUIElement? {
    if let focused = attribute(application, kAXFocusedWindowAttribute) { return (focused as! AXUIElement) }
    if let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement], let first = windows.first { return first }
    return nil
}

func walk(_ root: AXUIElement) -> [Node] {
    var nodes: [Node] = []
    func visit(_ element: AXUIElement, _ depth: Int) {
        if depth > 90 || nodes.count > 8000 { return }
        let role = text(element, kAXRoleAttribute)
        let subrole = text(element, kAXSubroleAttribute)
        let label = [text(element, kAXTitleAttribute), text(element, kAXDescriptionAttribute)].filter { !$0.isEmpty }.joined(separator: " ")
        let value = role == "AXStaticText" ? text(element, kAXValueAttribute) : ""
        nodes.append(Node(element: element, role: role, subrole: subrole, label: label, value: value))
        for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { visit(child, depth + 1) }
    }
    visit(root, 0)
    return nodes
}

func isSecure(_ node: Node) -> Bool { node.subrole == "AXSecureTextField" || node.role == "AXSecureTextField" }
func isTextField(_ node: Node) -> Bool { !isSecure(node) && (node.role == "AXTextField" || node.role == "AXTextArea") }

func secureLength(_ node: Node) -> Int {
    if let count = attribute(node.element, kAXNumberOfCharactersAttribute) as? Int { return count }
    return ((attribute(node.element, kAXValueAttribute) as? String) ?? "").count
}

func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

/// The desktop guard: a static label when the window must not be recorded.
func guardLabel(_ nodes: [Node]) -> String? {
    if nodes.contains(where: { isSecure($0) && secureLength($0) > 0 }) { return "Password entry" }
    if nodes.filter(isTextField).count >= 6 { return "Recovery phrase entry" }
    let joined = nodes.filter { $0.role == "AXStaticText" }.map(\.value).joined(separator: "\n")
    if matches(joined, "(recovery phrase|write these words|seed phrase|12 words)") { return "Recovery phrase screen" }
    if joined.range(of: "(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})", options: .regularExpression) != nil { return "Private key text" }
    return nil
}

func point(_ element: AXUIElement, _ name: String) -> CGPoint {
    guard let raw = attribute(element, name) else { return .zero }
    var result = CGPoint.zero
    AXValueGetValue(raw as! AXValue, .cgPoint, &result)
    return result
}

func size(_ element: AXUIElement, _ name: String) -> CGSize {
    guard let raw = attribute(element, name) else { return .zero }
    var result = CGSize.zero
    AXValueGetValue(raw as! AXValue, .cgSize, &result)
    return result
}

func activate(_ pid: pid_t) {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
}

func typeText(_ value: String, into pid: pid_t) {
    let source = CGEventSource(stateID: .hidSystemState)
    for character in value {
        let units = Array(String(character).utf16)
        let keyCode: CGKeyCode = character == " " ? 49 : 0
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.postToPid(pid)
        up.postToPid(pid)
        usleep(18_000)
    }
}

func pressKey(_ keyCode: CGKeyCode, into pid: pid_t) {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)?.postToPid(pid)
    CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)?.postToPid(pid)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("no command") }

switch command {
case "trusted":
    emit(["trusted": AXIsProcessTrusted()])

case "scale":
    let screen = NSScreen.screens.first
    emit(["scale": screen?.backingScaleFactor ?? 1, "width": screen?.frame.width ?? 0, "height": screen?.frame.height ?? 0])

case "frontmost":
    let front = NSWorkspace.shared.frontmostApplication
    emit(["pid": Int(front?.processIdentifier ?? 0), "bundle": front?.bundleIdentifier ?? ""])

case "activate":
    guard args.count >= 2 else { fail("usage: activate <pid>") }
    let (_, pid) = app(args[1])
    activate(pid)
    emit(["ok": true])

case "window":
    guard args.count >= 2 else { fail("usage: window <pid>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { emit(["found": false]); exit(0) }
    let origin = point(window, kAXPositionAttribute)
    let extent = size(window, kAXSizeAttribute)
    emit(["found": true, "x": origin.x, "y": origin.y, "w": extent.width, "h": extent.height])

case "place":
    guard args.count >= 6, let x = Double(args[2]), let y = Double(args[3]), let w = Double(args[4]), let h = Double(args[5]) else { fail("usage: place <pid> x y w h") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    var origin = CGPoint(x: x, y: y)
    var extent = CGSize(width: w, height: h)
    AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &extent)!)
    emit(["ok": true])

case "snapshot":
    // Static texts and control labels in tree order, plus the guard verdict.
    guard args.count >= 2 else { fail("usage: snapshot <pid>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { emit(["window": false]); exit(0) }
    let nodes = walk(window)
    let label = guardLabel(nodes)
    let secureFields = nodes.filter(isSecure).count
    if let label {
        emit(["window": true, "guard": label, "secureFields": secureFields, "texts": [], "buttons": []])
    } else {
        emit([
            "window": true,
            "guard": NSNull(),
            "secureFields": secureFields,
            "textFields": nodes.filter(isTextField).count,
            "texts": nodes.filter { $0.role == "AXStaticText" && !$0.value.isEmpty }.map(\.value),
            "buttons": nodes.filter { $0.role == "AXButton" || $0.role == "AXLink" }.map(\.label),
        ])
    }

case "press":
    // press <pid> <role|any> <label regex> [nth]: AXPress on the nth match.
    guard args.count >= 4 else { fail("usage: press <pid> <role> <regex> [nth]") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let nth = args.count >= 5 ? Int(args[4]) ?? 0 : 0
    let wanted = args[2]
    let hits = walk(window).filter { (wanted == "any" || $0.role == wanted) && matches($0.label, args[3]) }
    guard hits.count > nth else { emit(["ok": false, "matches": hits.count]); exit(0) }
    activate(pid)
    let result = AXUIElementPerformAction(hits[nth].element, kAXPressAction as CFString)
    emit(["ok": result == .success])

case "press-after":
    // press-after <pid> <anchor text regex> <role>: the first control after a static text.
    guard args.count >= 4 else { fail("usage: press-after <pid> <anchor> <role>") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let nodes = walk(window)
    guard let anchor = nodes.firstIndex(where: { $0.role == "AXStaticText" && matches($0.value, args[2]) }) else { emit(["ok": false, "anchor": false]); exit(0) }
    guard let target = nodes[(anchor + 1)...].first(where: { $0.role == args[3] }) else { emit(["ok": false, "anchor": true]); exit(0) }
    activate(pid)
    emit(["ok": AXUIElementPerformAction(target.element, kAXPressAction as CFString) == .success])

case "focus":
    // focus <pid> <text|secure> <index>
    guard args.count >= 4, let index = Int(args[3]) else { fail("usage: focus <pid> <text|secure> <index>") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let fields = walk(window).filter { args[2] == "secure" ? isSecure($0) : isTextField($0) }
    guard fields.count > index else { emit(["ok": false, "fields": fields.count]); exit(0) }
    activate(pid)
    let result = AXUIElementSetAttributeValue(fields[index].element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    emit(["ok": result == .success])

case "type":
    // type <pid>: the text arrives on stdin and goes only to the app.
    guard args.count >= 2 else { fail("usage: type <pid>") }
    let (_, pid) = app(args[1])
    var value = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    if value.hasSuffix("\n") { value.removeLast() }
    activate(pid)
    usleep(150_000)
    typeText(value, into: pid)
    value = String(repeating: " ", count: value.count)
    emit(["ok": true])

case "key":
    // key <pid> <escape|return|tab>
    guard args.count >= 3 else { fail("usage: key <pid> <name>") }
    let (_, pid) = app(args[1])
    let codes: [String: CGKeyCode] = ["escape": 53, "return": 36, "tab": 48]
    guard let code = codes[args[2]] else { fail("unknown key") }
    activate(pid)
    pressKey(code, into: pid)
    emit(["ok": true])

default:
    fail("unknown command")
}
