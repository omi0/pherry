import Foundation
import XCTest
@testable import PherryKit

/// HChaCha20 / XChaCha20-Poly1305 against both the generated `@noble` vectors and the published
/// IRTF `draft-irtf-cfrg-xchacha` reference vectors.
final class CryptoVectorTests: XCTestCase {
    func testHChaCha20Vectors() throws {
        let vectors = Vectors.load("hchacha")
        let cases = vectors["cases"] as! [[String: Any]]
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let key = hexData(testCase["keyHex"] as! String)
            let input16 = hexData(testCase["input16Hex"] as! String)
            let expected = hexData(testCase["subkeyHex"] as! String)
            let subkey = try HChaCha20.derive(key: key, input16: input16)
            XCTAssertEqual(subkey, expected, testCase["description"] as? String ?? "")
        }
    }

    func testXChaChaSealVectors() throws {
        let vectors = Vectors.load("xchacha")
        let cases = vectors["cases"] as! [[String: Any]]
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let key = hexData(testCase["keyHex"] as! String)
            let nonce = hexData(testCase["nonce24Hex"] as! String)
            let plaintext = hexData(testCase["plaintextHex"] as! String)
            let expected = hexData(testCase["ciphertextHex"] as! String)
            let sealed = try XChaCha20Poly1305.seal(key: key, nonce24: nonce, plaintext: plaintext)
            XCTAssertEqual(sealed, expected, testCase["description"] as? String ?? "")
            // Round-trip.
            let opened = try XChaCha20Poly1305.open(key: key, nonce24: nonce, ciphertext: sealed)
            XCTAssertEqual(opened, plaintext)
        }
    }

    func testXChaChaOpenRejectsTamper() throws {
        let key = Data(repeating: 0x11, count: 32)
        let nonce = Data(repeating: 0x22, count: 24)
        var sealed = try XChaCha20Poly1305.seal(key: key, nonce24: nonce, plaintext: Data("secret".utf8))
        sealed[sealed.startIndex] ^= 0x01
        XCTAssertThrowsError(try XChaCha20Poly1305.open(key: key, nonce24: nonce, ciphertext: sealed)) { error in
            XCTAssertEqual(error as? CryptoError, .decryptFailed)
        }
    }

    /// The published IRTF reference vectors, hardcoded — HChaCha20 (Section 2.2.1) and the
    /// XChaCha20-Poly1305 AEAD example (Appendix A.3.1, which authenticates AAD).
    func testIRTFHChaCha20() throws {
        let key = hexData("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        let input = hexData("000000090000004a0000000031415927")
        let expected = hexData("82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc")
        XCTAssertEqual(try HChaCha20.derive(key: key, input16: input), expected)

        // And the same value the generator committed.
        let vectors = Vectors.load("irtf")
        let hchacha = vectors["hchacha20"] as! [String: Any]
        XCTAssertEqual(hexData(hchacha["subkeyHex"] as! String), expected)
    }

    func testIRTFXChaCha20Poly1305AEAD() throws {
        let key = hexData("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        let nonce = hexData("404142434445464748494a4b4c4d4e4f5051525354555657")
        let aad = hexData("50515253c0c1c2c3c4c5c6c7")
        let plaintext = Data("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let expected = hexData("bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49")

        let sealed = try XChaCha20Poly1305.seal(key: key, nonce24: nonce, plaintext: plaintext, aad: aad)
        XCTAssertEqual(sealed, expected)
        let opened = try XChaCha20Poly1305.open(key: key, nonce24: nonce, ciphertext: sealed, aad: aad)
        XCTAssertEqual(opened, plaintext)
    }
}
