// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// Mirror of the protocol's parameter struct (telegraph-examples/contracts/interfaces/OnChainData.sol).
struct OnChainData {
    address[] addresses;
    uint256[] integers;
    string[] strings;
    bool[] bools;
}

interface ITelegraph {
    function createJob(bytes32 intentId, OnChainData memory params, address callback)
        external
        returns (uint256 jobId);
    function depositUSDC(uint256 amount) external;
    function escrowBalance(address account) external view returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Amanat — parametric weather cover settled by verified intelligence
/// @notice A policy is an *amanat*: a mandate the contract carries out on its
///         holder's behalf without anyone deciding anything by hand.
///
///         The contract is the customer of the intelligence, not a front end
///         calling an API. It opens an ERC-8183 job against a weather intent,
///         Telegraph routes that job to whichever miner currently ranks best,
///         validators finalise the answer, and the protocol delivers it back
///         through `subnetMessage`. Only then does the contract pay or decline.
///
///         Two consequences shape the design, and neither has a workaround:
///
///         1. The answer arrives from a miner nobody here chose. `OnChainData`
///            is packed according to *that* miner's YAML, so this contract can
///            never assume a field layout. It validates what arrived and
///            declines the claim if the shape is not one it understands.
///         2. Delivery is asynchronous and not guaranteed on a deadline. Funds
///            stay escrowed against the policy until an answer lands, and the
///            holder can reclaim them after `CLAIM_TIMEOUT` if none ever does.
contract Amanat {
    // ── Wiring ──────────────────────────────────────────────────────────────

    /// The Telegraph Diamond. It is the only address allowed to deliver results.
    address public immutable telegraph;
    IERC20 public immutable payoutToken;
    address public immutable underwriter;

    /// Risk at or above this pays out. Scaled 1e4, matching the miner YAML's
    /// `risk_x10000` field, so no floating point ever enters the contract.
    uint256 public constant PAYOUT_THRESHOLD = 7500;

    /// A job that never comes back must not strand the holder's premium.
    uint256 public constant CLAIM_TIMEOUT = 24 hours;

    // ── Policies ────────────────────────────────────────────────────────────

    enum Status { None, Active, Claimed, Declined, Expired }

    struct Policy {
        address holder;
        string lat;          // decimal degrees as text: the job carries strings
        string lon;
        uint256 payout;      // in payoutToken units, escrowed at creation
        Status status;
        uint256 openedAt;
        uint256 jobId;       // 0 until a check is requested
        uint256 riskReported; // scaled 1e4, set when an answer lands
    }

    uint256 public nextPolicyId = 1;
    mapping(uint256 => Policy) public policies;
    mapping(uint256 => uint256) public policyOfJob;

    event PolicyOpened(uint256 indexed policyId, address indexed holder, uint256 payout);
    event CheckRequested(uint256 indexed policyId, uint256 indexed jobId, bytes32 intentId);
    event AnswerReceived(uint256 indexed policyId, uint256 indexed jobId, uint256 riskX10000, string summary);
    event Paid(uint256 indexed policyId, address indexed holder, uint256 amount);
    event Declined(uint256 indexed policyId, string reason);
    event Expired(uint256 indexed policyId, uint256 refunded);

    error NotTelegraph();
    error NotUnderwriter();
    error NotHolder();
    error WrongStatus();
    error NothingPending();
    error TooEarly();

    constructor(address _telegraph, address _payoutToken) {
        telegraph = _telegraph;
        payoutToken = IERC20(_payoutToken);
        underwriter = msg.sender;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /// Open a policy for a point. The payout must already be sitting in this
    /// contract; the underwriter funds the book, the holder owns the claim.
    function openPolicy(address holder, string calldata lat, string calldata lon, uint256 payout)
        external
        returns (uint256 policyId)
    {
        if (msg.sender != underwriter) revert NotUnderwriter();
        // Never write a policy the book cannot honour.
        require(payoutToken.balanceOf(address(this)) >= _outstanding() + payout, "underfunded");

        policyId = nextPolicyId++;
        policies[policyId] = Policy({
            holder: holder,
            lat: lat,
            lon: lon,
            payout: payout,
            status: Status.Active,
            openedAt: block.timestamp,
            jobId: 0,
            riskReported: 0
        });
        _outstandingTotal += payout;
        emit PolicyOpened(policyId, holder, payout);
    }

    /// Ask Telegraph for a storm reading on this policy's point.
    ///
    /// `intentId` is `keccak256("STORM_ALERT")` or `keccak256("WEATHER_FORECAST")`
    /// — a name hash, so the protocol picks the miner. Passing a registration
    /// derived intentId would pin one miner and defeat the purpose.
    ///
    /// `hoursAhead` rides in `integers[0]` and the coordinates in `strings[0..1]`,
    /// which is the mapping every weather miner's `on_chain.request` block reads.
    function requestCheck(uint256 policyId, bytes32 intentId, uint256 hoursAhead) external returns (uint256 jobId) {
        Policy storage p = policies[policyId];
        if (msg.sender != underwriter && msg.sender != p.holder) revert NotHolder();
        if (p.status != Status.Active) revert WrongStatus();

        OnChainData memory params;
        params.addresses = new address[](0);
        params.bools = new bool[](0);
        params.integers = new uint256[](1);
        params.integers[0] = hoursAhead;
        params.strings = new string[](2);
        params.strings[0] = p.lat;
        params.strings[1] = p.lon;

        jobId = ITelegraph(telegraph).createJob(intentId, params, address(this));
        p.jobId = jobId;
        policyOfJob[jobId] = policyId;
        emit CheckRequested(policyId, jobId, intentId);
    }

    /// Delivered by the protocol once validators finalise the job. The name is
    /// the protocol's; it carries a miner's answer.
    function subnetMessage(
        uint256 jobId,
        bool success,
        OnChainData memory response,
        string memory errorMessage
    ) external {
        if (msg.sender != telegraph) revert NotTelegraph();

        uint256 policyId = policyOfJob[jobId];
        Policy storage p = policies[policyId];
        // An answer for an unknown or already-settled policy is dropped rather
        // than reverted: reverting here would strand the protocol's callback.
        if (policyId == 0 || p.status != Status.Active) return;

        if (!success) {
            emit Declined(policyId, bytes(errorMessage).length > 0 ? errorMessage : "miner error");
            return; // stays Active; the check can be retried
        }

        // The miner that answered was chosen by the protocol, so the payload
        // layout is only a convention. Read defensively and decline anything
        // this contract cannot interpret — never guess at a payout.
        (bool ok, uint256 riskX10000) = _readRisk(response);
        string memory summary = response.strings.length > 0 ? response.strings[0] : "";
        if (!ok) {
            emit Declined(policyId, "unreadable answer shape");
            return;
        }

        p.riskReported = riskX10000;
        emit AnswerReceived(policyId, jobId, riskX10000, summary);

        if (riskX10000 >= PAYOUT_THRESHOLD) {
            p.status = Status.Claimed;
            _outstandingTotal -= p.payout;
            require(payoutToken.transfer(p.holder, p.payout), "payout failed");
            emit Paid(policyId, p.holder, p.payout);
        } else {
            p.status = Status.Declined;
            _outstandingTotal -= p.payout;
            emit Declined(policyId, "below threshold");
        }
    }

    /// Release a policy whose answer never arrived, so a silent rail cannot
    /// hold the book hostage.
    /// @dev `block.timestamp` is validator-influenceable by seconds. Against a
    ///      24-hour timeout that buys an attacker nothing: the only thing they
    ///      could do is release a reserve a few seconds early or late, and the
    ///      reserve returns to the book either way.
    function expire(uint256 policyId) external {
        Policy storage p = policies[policyId];
        if (p.status != Status.Active) revert WrongStatus();
        if (block.timestamp < p.openedAt + CLAIM_TIMEOUT) revert TooEarly();
        p.status = Status.Expired;
        _outstandingTotal -= p.payout;
        emit Expired(policyId, p.payout);
    }

    // ── Reading a miner's answer ────────────────────────────────────────────

    uint256 private _outstandingTotal;

    function _outstanding() internal view returns (uint256) {
        return _outstandingTotal;
    }

    /// Pull a 1e4-scaled risk out of whatever the miner sent.
    ///
    /// Amanat's own YAML puts it at `integers[3]`, but a different miner may
    /// pack fewer fields, so this accepts the two shapes it can verify and
    /// rejects the rest. `bools[0]` alone is enough when a miner reports only a
    /// breach flag: a flag that says "yes" is a risk at the threshold.
    function _readRisk(OnChainData memory r) internal pure returns (bool ok, uint256 riskX10000) {
        if (r.integers.length >= 4) {
            uint256 v = r.integers[3];
            if (v <= 10000) return (true, v);
        }
        if (r.bools.length >= 1) {
            return (true, r.bools[0] ? PAYOUT_THRESHOLD : 0);
        }
        return (false, 0);
    }

    // ── Escrow ──────────────────────────────────────────────────────────────

    /// Move USDC from the book into this contract's escrow on the Diamond.
    ///
    /// `createJob` draws on the escrow of whoever calls it, and the caller here
    /// is this contract — not the wallet that deployed it. Funding the deployer's
    /// escrow instead leaves the contract unable to open a single job, which is
    /// the kind of thing you find out one transaction too late.
    function fundEscrow(uint256 amount) external {
        if (msg.sender != underwriter) revert NotUnderwriter();
        // Escrowed funds are spent on jobs, so they must not also be counted as
        // backing a policy.
        require(payoutToken.balanceOf(address(this)) >= _outstandingTotal + amount, "would strand a policy");
        payoutToken.approve(telegraph, amount);
        ITelegraph(telegraph).depositUSDC(amount);
    }

    /// What this contract can still spend on jobs.
    function jobBudget() external view returns (uint256) {
        return ITelegraph(telegraph).escrowBalance(address(this));
    }

    // ── Book management ─────────────────────────────────────────────────────

    /// Withdraw whatever is not backing a live policy.
    function sweep(address to) external {
        if (msg.sender != underwriter) revert NotUnderwriter();
        uint256 free = payoutToken.balanceOf(address(this)) - _outstandingTotal;
        if (free == 0) revert NothingPending();
        require(payoutToken.transfer(to, free), "sweep failed");
    }

    function outstanding() external view returns (uint256) {
        return _outstandingTotal;
    }
}
