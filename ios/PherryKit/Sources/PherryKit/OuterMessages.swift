import Foundation

/// The outer coordination messages a controller exchanges with a cell — un-encrypted JSON that
/// carries **only** routing metadata (a role, a ticket, a close code), never session content.
///
/// The Swift controller speaks a small slice of the full protocol: it sends `data-auth` and
/// reads `data-ready` or `close`. Rather than model every host-side message, this decodes the
/// inbound `t` discriminator and pulls the fields each relevant message needs.
enum OuterMessages {
    /// Encode the controller's `data-auth` message as its canonical JSON wire form.
    ///
    /// Shape: `{"t":"data-auth","role":"controller","ticket":"tkt_…"}`. Keys are emitted in a
    /// fixed order so the bytes are deterministic for the conformance vectors.
    static func encodeDataAuth(ticket: String) -> Data {
        // Hand-built to guarantee key order and avoid JSONSerialization's unordered output.
        let json = "{\"t\":\"data-auth\",\"role\":\"controller\",\"ticket\":\(jsonString(ticket))}"
        return Data(json.utf8)
    }

    /// A decoded inbound outer message — only the `t` discriminator and the fields the
    /// controller flow reads.
    enum Inbound {
        /// The bridge is complete; every byte after this frame is opaque channel bytes.
        case dataReady
        /// The cell refused or tore down, with a coded reason and an optional human note.
        case close(code: String?, reason: String?)
        /// Any other message type — unexpected in the controller flow.
        case other(type: String)
    }

    /// Decode one outer-message JSON payload, or `nil` if it is not valid JSON / not an object.
    static func decode(_ payload: Data) -> Inbound? {
        guard
            let object = try? JSONSerialization.jsonObject(with: payload),
            let dict = object as? [String: Any],
            let type = dict["t"] as? String
        else { return nil }
        switch type {
        case "data-ready":
            return .dataReady
        case "close":
            return .close(code: dict["code"] as? String, reason: dict["reason"] as? String)
        default:
            return .other(type: type)
        }
    }

    /// Encode a string as a JSON string literal (quotes + minimal escaping).
    private static func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
