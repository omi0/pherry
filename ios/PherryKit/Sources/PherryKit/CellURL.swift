import Foundation

/// Parse a relay cell address into a host and TCP port.
///
/// Accepts `tcp://host:port` and the bare `host:port` form; IPv6 literals may be bracketed
/// (`[::1]:9000`). The port is mandatory and must be 1–65535. Any other scheme (`http://`, …),
/// a missing host, or an out-of-range / non-numeric port throws — mirroring the CLI's
/// `parseCellUrl` so the two implementations accept exactly the same inputs.
public enum CellURL {
    /// A malformed cell URL.
    public struct ParseError: Error, Sendable, Equatable {
        /// What was wrong with the input.
        public let message: String
    }

    /// Parse `url` into `(host, port)`, or throw ``ParseError``.
    public static func parse(_ url: String) throws -> (host: String, port: UInt16) {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)

        let authority: String
        if trimmed.hasPrefix("tcp://") {
            authority = String(trimmed.dropFirst("tcp://".count))
        } else if hasScheme(trimmed) {
            throw ParseError(message: "unsupported cell URL \"\(url)\" — expected tcp://host:port or host:port")
        } else {
            authority = trimmed
        }

        // A cell URL is just an authority; drop any stray path / query / fragment.
        let hostPort = authority.split(whereSeparator: { $0 == "/" || $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""

        let host: String
        let portText: String
        if hostPort.hasPrefix("[") {
            guard let end = hostPort.firstIndex(of: "]") else {
                throw ParseError(message: "malformed cell URL \"\(url)\" — unclosed IPv6 bracket")
            }
            host = String(hostPort[hostPort.index(after: hostPort.startIndex)..<end])
            let rest = hostPort[hostPort.index(after: end)...]
            guard rest.hasPrefix(":") else {
                throw ParseError(message: "cell URL \"\(url)\" is missing a :port")
            }
            portText = String(rest.dropFirst())
        } else {
            guard let colon = hostPort.lastIndex(of: ":") else {
                throw ParseError(message: "cell URL \"\(url)\" is missing a :port")
            }
            host = String(hostPort[hostPort.startIndex..<colon])
            portText = String(hostPort[hostPort.index(after: colon)...])
        }

        guard !host.isEmpty else {
            throw ParseError(message: "cell URL \"\(url)\" is missing a host")
        }
        guard !portText.isEmpty, portText.allSatisfy({ $0.isNumber }), let port = UInt16(portText), port >= 1 else {
            throw ParseError(message: "cell URL \"\(url)\" has an invalid port")
        }
        return (host, port)
    }

    /// Whether `text` begins with a URL scheme (`scheme://`).
    private static func hasScheme(_ text: String) -> Bool {
        guard let range = text.range(of: "://") else { return false }
        let scheme = text[text.startIndex..<range.lowerBound]
        guard let first = scheme.first, first.isLetter else { return false }
        return scheme.allSatisfy { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "." || $0 == "-" }
    }
}
