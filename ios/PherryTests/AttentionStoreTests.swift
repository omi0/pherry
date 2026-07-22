import XCTest
@testable import Pherry

/// The inbox model's cursor, badge, and ack logic — the pure heart of the attention plane, driven
/// with a scripted API so no socket is opened.
@MainActor
final class AttentionStoreTests: XCTestCase {
    private final class BadgeSpy { var value = 0 }

    private func makeStore() -> (AttentionStore, BadgeSpy) {
        let spy = BadgeSpy()
        let store = AttentionStore(setBadge: { spy.value = $0 })
        return (store, spy)
    }

    func testApplyAdvancesCursorToNewest() {
        let (store, _) = makeStore()
        store.apply([
            makeAttentionItem(id: "a", createdAt: 100),
            makeAttentionItem(id: "b", createdAt: 300),
            makeAttentionItem(id: "c", createdAt: 200),
        ])
        XCTAssertEqual(store.since, 300)
        XCTAssertEqual(store.items.count, 3)
        // Newest first.
        XCTAssertEqual(store.items.map(\.id), ["b", "c", "a"])
    }

    func testCursorOnlyMovesForward() {
        let (store, _) = makeStore()
        store.apply([makeAttentionItem(id: "a", createdAt: 500)])
        XCTAssertEqual(store.since, 500)
        // A late batch with older events must not rewind the cursor.
        store.apply([makeAttentionItem(id: "b", createdAt: 200)])
        XCTAssertEqual(store.since, 500)
    }

    func testApplyDedupesById() {
        let (store, _) = makeStore()
        store.apply([makeAttentionItem(id: "a", createdAt: 100)])
        store.apply([makeAttentionItem(id: "a", createdAt: 100), makeAttentionItem(id: "b", createdAt: 150)])
        XCTAssertEqual(store.items.map(\.id).sorted(), ["a", "b"])
    }

    func testBadgeTracksUnackedCount() {
        let (store, spy) = makeStore()
        store.apply([
            makeAttentionItem(id: "a", createdAt: 1),
            makeAttentionItem(id: "b", createdAt: 2),
        ])
        XCTAssertEqual(spy.value, 2)
        XCTAssertEqual(store.unreadCount, 2)
    }

    func testAckRemovesLocallyAndCallsApiAndUpdatesBadge() async {
        let (store, spy) = makeStore()
        let stub = StubAttentionAPI()
        store.configure(api: stub)
        store.apply([
            makeAttentionItem(id: "a", createdAt: 1),
            makeAttentionItem(id: "b", createdAt: 2),
        ])
        XCTAssertEqual(spy.value, 2)

        await store.ack(id: "a")

        XCTAssertEqual(store.items.map(\.id), ["b"])
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertEqual(spy.value, 1)
        let acked = await stub.ackedIds
        XCTAssertEqual(acked, ["a"])
    }

    func testConfigureResetsStateAndBadge() {
        let (store, spy) = makeStore()
        store.apply([makeAttentionItem(id: "a", createdAt: 1)])
        XCTAssertEqual(spy.value, 1)

        store.configure(api: nil)

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertNil(store.since)
        XCTAssertEqual(spy.value, 0)
    }

    func testItemLookupById() {
        let (store, _) = makeStore()
        store.apply([makeAttentionItem(id: "a", createdAt: 1, summary: "hi")])
        XCTAssertEqual(store.item(id: "a")?.summary, "hi")
        XCTAssertNil(store.item(id: "nope"))
    }
}
