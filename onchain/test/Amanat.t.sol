// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/Amanat.sol";

/// Minimal ERC-20 standing in for Circle's USDC. A test double, not a product
/// mock: the tests need a token whose balances they control, and Circle's is not
/// deployable here.
contract TestUSDC is IERC20 {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;
    bool public transfersFail;

    function mint(address to, uint256 amount) external { balances[to] += amount; }
    function setTransfersFail(bool v) external { transfersFail = v; }

    function balanceOf(address a) external view returns (uint256) { return balances[a]; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transfersFail) return false;
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }
}

/// Stands in for the Telegraph Diamond: records what was asked of it and lets a
/// test drive the callback the way the protocol would.
contract TestTelegraph is ITelegraph {
    uint256 public nextJobId = 100;
    uint256 public escrow;
    IERC20 public token;

    bytes32 public lastIntent;
    address public lastCallback;
    string[] public lastStrings;
    uint256[] public lastIntegers;

    constructor(IERC20 _token) { token = _token; }

    function createJob(bytes32 intentId, OnChainData memory params, address callback)
        external
        returns (uint256)
    {
        require(escrow >= 1e6, "insufficient escrow balance");
        escrow -= 1e6;
        lastIntent = intentId;
        lastCallback = callback;
        lastStrings = params.strings;
        lastIntegers = params.integers;
        return nextJobId++;
    }

    function depositUSDC(uint256 amount) external { escrow += amount; }
    function escrowBalance(address) external view returns (uint256) { return escrow; }

    function deliver(address callback, uint256 jobId, bool success, OnChainData memory data, string memory err)
        external
    {
        Amanat(callback).subnetMessage(jobId, success, data, err);
    }
}

contract AmanatTest is Test {
    TestUSDC usdc;
    TestTelegraph telegraph;
    Amanat book;

    address underwriter = address(this);
    address holder = address(0xB0B);

    uint256 constant PAYOUT = 1e6;      // 1 USDC
    uint256 constant BOOK = 10e6;

    function setUp() public {
        usdc = new TestUSDC();
        telegraph = new TestTelegraph(usdc);
        book = new Amanat(address(telegraph), address(usdc));
        usdc.mint(address(book), BOOK);
    }

    function _reading(uint256 riskX10000, bool breach) internal pure returns (OnChainData memory d) {
        d.addresses = new address[](0);
        d.strings = new string[](1);
        d.strings[0] = "a forecast";
        d.integers = new uint256[](4);
        d.integers[3] = riskX10000;
        d.bools = new bool[](1);
        d.bools[0] = breach;
    }

    function _openAndCheck(uint256 riskX10000) internal returns (uint256 policyId, uint256 jobId) {
        policyId = book.openPolicy(holder, "10.32", "123.89", PAYOUT);
        book.fundEscrow(2e6);
        jobId = book.requestCheck(policyId, keccak256("STORM_ALERT"), 1);
        telegraph.deliver(address(book), jobId, true, _reading(riskX10000, riskX10000 >= 7500), "");
    }

    // ── who may do what ──────────────────────────────────────────────────────

    function test_onlyUnderwriterOpensPolicies() public {
        vm.prank(holder);
        vm.expectRevert(Amanat.NotUnderwriter.selector);
        book.openPolicy(holder, "1", "2", PAYOUT);
    }

    function test_holderMayRequestTheirOwnCheck() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        vm.prank(holder);
        book.requestCheck(id, keccak256("STORM_ALERT"), 1);
    }

    function test_strangerMayNotRequestACheck() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        vm.prank(address(0xDEAD));
        vm.expectRevert(Amanat.NotHolder.selector);
        book.requestCheck(id, keccak256("STORM_ALERT"), 1);
    }

    /// The callback is the whole trust boundary: anyone able to call it can pay
    /// themselves out of the book.
    function test_onlyTelegraphDelivers() public {
        (uint256 id, uint256 jobId) = _openAndCheck(3000);
        vm.prank(address(0xDEAD));
        vm.expectRevert(Amanat.NotTelegraph.selector);
        book.subnetMessage(jobId, true, _reading(9000, true), "");
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Declined));
    }

    // ── the book cannot promise what it does not hold ────────────────────────

    function test_refusesAPolicyTheBookCannotHonour() public {
        book.openPolicy(holder, "1", "2", BOOK);
        vm.expectRevert("underfunded");
        book.openPolicy(holder, "1", "2", 1);
    }

    function test_escrowMayNotStrandAPolicy() public {
        book.openPolicy(holder, "1", "2", BOOK);
        vm.expectRevert("would strand a policy");
        book.fundEscrow(1e6);
    }

    function test_sweepLeavesTheOutstandingCoverBehind() public {
        book.openPolicy(holder, "1", "2", PAYOUT);
        book.sweep(underwriter);
        assertEq(usdc.balanceOf(address(book)), PAYOUT, "cover for the open policy must stay");
        assertEq(usdc.balanceOf(underwriter), BOOK - PAYOUT);
    }

    function test_onlyUnderwriterSweeps() public {
        vm.prank(holder);
        vm.expectRevert(Amanat.NotUnderwriter.selector);
        book.sweep(holder);
    }

    // ── settlement ───────────────────────────────────────────────────────────

    function test_paysWhenTheReadingCrossesTheTrigger() public {
        (uint256 id, ) = _openAndCheck(8000);
        (, , , , Amanat.Status status, , , uint256 risk) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Claimed));
        assertEq(risk, 8000);
        assertEq(usdc.balanceOf(holder), PAYOUT, "the holder is paid in the same transaction");
        assertEq(book.outstanding(), 0);
    }

    function test_paysExactlyAtTheTrigger() public {
        (uint256 id, ) = _openAndCheck(7500);
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Claimed), "at the line is a payout");
    }

    function test_declinesJustBelowTheTrigger() public {
        (uint256 id, ) = _openAndCheck(7499);
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Declined));
        assertEq(usdc.balanceOf(holder), 0);
        assertEq(book.outstanding(), 0, "a declined policy stops being owed");
    }

    // ── answers the contract cannot trust ────────────────────────────────────

    /// The miner is chosen by the protocol, so the payload shape is a convention
    /// and not a promise. An unreadable one must decline, never guess.
    function test_declinesAPayloadItCannotRead() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        uint256 jobId = book.requestCheck(id, keccak256("STORM_ALERT"), 1);

        OnChainData memory empty;
        empty.addresses = new address[](0);
        empty.strings = new string[](0);
        empty.integers = new uint256[](0);
        empty.bools = new bool[](0);
        telegraph.deliver(address(book), jobId, true, empty, "");

        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Active), "still open, not paid on a guess");
        assertEq(usdc.balanceOf(holder), 0);
    }

    function test_readsABreachFlagWhenThatIsAllThereIs() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        uint256 jobId = book.requestCheck(id, keccak256("STORM_ALERT"), 1);

        OnChainData memory flagOnly;
        flagOnly.addresses = new address[](0);
        flagOnly.strings = new string[](0);
        flagOnly.integers = new uint256[](0);
        flagOnly.bools = new bool[](1);
        flagOnly.bools[0] = true;
        telegraph.deliver(address(book), jobId, true, flagOnly, "");

        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Claimed), "a flag that says yes is a risk at the line");
    }

    function test_ignoresAnOutOfRangeRisk() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        uint256 jobId = book.requestCheck(id, keccak256("STORM_ALERT"), 1);
        telegraph.deliver(address(book), jobId, true, _reading(20000, true), "");

        // 20000 is not a risk in [0,1]; the integers path refuses it and the
        // bools path answers instead, which is a reading the contract can defend.
        (, , , , Amanat.Status status, , , uint256 risk) = book.policies(id);
        assertEq(risk, book.PAYOUT_THRESHOLD());
        assertEq(uint256(status), uint256(Amanat.Status.Claimed));
    }

    function test_aFailedJobLeavesThePolicyOpen() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        uint256 jobId = book.requestCheck(id, keccak256("STORM_ALERT"), 1);
        telegraph.deliver(address(book), jobId, false, _reading(9000, true), "miner timed out");

        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Active), "retryable, not settled on a failure");
    }

    /// Reverting inside the callback would strand the protocol's delivery, so an
    /// answer for something already settled is dropped instead.
    function test_aSecondAnswerIsDropped() public {
        (uint256 id, uint256 jobId) = _openAndCheck(8000);
        uint256 paid = usdc.balanceOf(holder);
        telegraph.deliver(address(book), jobId, true, _reading(9000, true), "");
        assertEq(usdc.balanceOf(holder), paid, "no second payout");
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Claimed));
    }

    function test_anAnswerForAnUnknownJobIsDropped() public {
        telegraph.deliver(address(book), 999, true, _reading(9000, true), "");
        assertEq(usdc.balanceOf(holder), 0);
    }

    // ── the rail going quiet must not hold the book ──────────────────────────

    function test_cannotExpireBeforeTheTimeout() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        vm.expectRevert(Amanat.TooEarly.selector);
        book.expire(id);
    }

    function test_expiresAfterTheTimeout() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        vm.warp(block.timestamp + 24 hours + 1);
        book.expire(id);
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Expired));
        assertEq(book.outstanding(), 0, "the reserve is released");
    }

    function test_anyoneMayExpireAStuckPolicy() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(address(0xDEAD));
        book.expire(id);
        (, , , , Amanat.Status status, , , ) = book.policies(id);
        assertEq(uint256(status), uint256(Amanat.Status.Expired));
    }

    function test_aSettledPolicyCannotBeExpired() public {
        (uint256 id, ) = _openAndCheck(8000);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(Amanat.WrongStatus.selector);
        book.expire(id);
    }

    // ── the job it opens ─────────────────────────────────────────────────────

    function test_opensTheJobAgainstAnIntentAndCarriesTheCoordinates() public {
        uint256 id = book.openPolicy(holder, "10.32", "123.89", PAYOUT);
        book.fundEscrow(2e6);
        book.requestCheck(id, keccak256("STORM_ALERT"), 3);

        assertEq(telegraph.lastIntent(), keccak256("STORM_ALERT"), "the intent, not a miner");
        assertEq(telegraph.lastCallback(), address(book));
        assertEq(telegraph.lastStrings(0), "10.32");
        assertEq(telegraph.lastStrings(1), "123.89");
        assertEq(telegraph.lastIntegers(0), 3);
    }

    function test_cannotCheckAPolicyThatIsNotOpen() public {
        (uint256 id, ) = _openAndCheck(1000);
        book.fundEscrow(2e6);
        vm.expectRevert(Amanat.WrongStatus.selector);
        book.requestCheck(id, keccak256("STORM_ALERT"), 1);
    }

    // ── a token that lies ────────────────────────────────────────────────────

    /// USDC returns a bool. A token that returns false without reverting must not
    /// leave the contract believing it paid.
    function test_revertsIfThePayoutTransferFails() public {
        uint256 id = book.openPolicy(holder, "1", "2", PAYOUT);
        book.fundEscrow(2e6);
        uint256 jobId = book.requestCheck(id, keccak256("STORM_ALERT"), 1);
        usdc.setTransfersFail(true);

        vm.expectRevert("payout failed");
        telegraph.deliver(address(book), jobId, true, _reading(9000, true), "");
    }

    // ── accounting holds under a sequence ────────────────────────────────────

    function testFuzz_outstandingNeverExceedsTheBalance(uint8 count) public {
        count = uint8(bound(count, 1, 9));
        for (uint256 i = 0; i < count; i++) {
            book.openPolicy(holder, "1", "2", PAYOUT);
        }
        assertLe(book.outstanding(), usdc.balanceOf(address(book)));
    }
}
