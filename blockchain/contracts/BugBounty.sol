// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BugBounty - Bug Bounty & Responsible Disclosure Platform
/// @notice Companies admitted by the Disclosure Council publish bounty programs. The
///         rewards are locked in this contract (escrow) together with the company's RSA
///         public key. A researcher encrypts the report for that company off-chain and
///         commits only two hashes here, which gives a timestamped, tamper-proof proof of
///         who found a bug first without revealing the bug. Accepting a report pays the
///         bounty from escrow automatically. If the company rejects a report, marks it as
///         a duplicate or ignores it past the response deadline, the researcher can
///         escalate to the Council, which acts as a neutral arbiter and can force payout.
/// @dev Nothing secret is stored on-chain: only hashes, public keys, amounts and times.
///      Every payout follows checks-effects-interactions and runs behind a re-entrancy lock.
contract BugBounty {
    enum Severity { Low, Medium, High, Critical }
    /// @dev The company's decision on a report.
    enum Status { Pending, Accepted, Rejected, Duplicate }
    /// @dev The arbiter's view of a report.
    enum Dispute { None, Open, ResearcherWon, CompanyWon }

    struct Company {
        string name;
        bool active;
        uint64 joinedAt;
    }

    struct Researcher {
        string handle;
        uint64 joinedAt;
        uint32 submitted;
        uint32 accepted;    // reports paid (by the company or by the arbiter)
        uint256 earned;     // total wei received, used for the leaderboard
    }

    struct Program {
        address company;
        string name;
        string scope;
        string publicKey;         // RSA-OAEP 2048 public key (SPKI, base64) used to encrypt reports
        uint256[4] rewards;       // wei per severity: Low, Medium, High, Critical
        uint256 escrow;           // wei still locked for this program
        uint256 paid;             // wei paid out so far
        uint64 responseWindow;    // seconds the company has to respond (and a researcher to appeal)
        uint64 createdAt;
        uint64 appealsOpenUntil;  // the escrow cannot be withdrawn before this time
        uint32 openReports;       // reports waiting for the company or for the arbiter
        uint32 reportCount;
        bool open;
    }

    struct Report {
        uint256 programId;
        address researcher;
        bytes32 reportHash;       // sha256(plaintext report JSON): commitment to the content
        bytes32 cipherHash;       // sha256(encrypted package): identifies the off-chain ciphertext
        Severity claimed;
        Severity awarded;
        Status status;
        Dispute dispute;
        uint64 submittedAt;       // block time = proof of priority
        uint64 respondedAt;       // when the company decided (0 = no answer yet)
        uint64 escalatedAt;
        uint64 resolvedAt;
        uint256 duplicateOf;      // earlier report id, only meaningful when status == Duplicate
        uint256 payout;           // wei paid for this report
        string reason;            // the company's public rejection reason
    }

    uint64 public constant MIN_WINDOW = 1 hours;
    uint64 public constant MAX_WINDOW = 30 days;

    /// @notice The Disclosure Council: platform admin and neutral arbiter (the deployer).
    address public immutable council;
    uint256 public totalPaid;

    mapping(address => Company) public companies;
    address[] private companyList;
    mapping(address => Researcher) public researchers;
    address[] private researcherList;
    mapping(bytes32 => address) private handleOwner; // keccak256(handle) => researcher

    Program[] private programs;
    Report[] private reports;
    mapping(uint256 => uint256[]) private programReports;
    mapping(address => uint256[]) private researcherReports;
    mapping(bytes32 => uint256) private hashIndex; // reportHash or cipherHash => reportId + 1

    uint256 private lock = 1;

    event CompanyRegistered(address indexed account, string name);
    event CompanyStatusChanged(address indexed account, bool active);
    event ResearcherRegistered(address indexed account, string handle);
    event ProgramCreated(uint256 indexed programId, address indexed company, string name, uint256 escrow, uint64 responseWindow);
    event ProgramToppedUp(uint256 indexed programId, uint256 amount, uint256 escrow);
    event ProgramClosed(uint256 indexed programId, uint256 refund);
    event ReportSubmitted(uint256 indexed reportId, uint256 indexed programId, address indexed researcher, bytes32 reportHash, bytes32 cipherHash, Severity claimed);
    event ReportAccepted(uint256 indexed reportId, Severity severity, uint256 payout);
    event ReportRejected(uint256 indexed reportId, string reason, uint64 appealDeadline);
    event ReportMarkedDuplicate(uint256 indexed reportId, uint256 indexed originalReportId, uint64 appealDeadline);
    event ReportEscalated(uint256 indexed reportId, address indexed researcher, Status companyDecision);
    event DisputeResolved(uint256 indexed reportId, bool inFavourOfResearcher, Severity severity, uint256 payout);
    event BountyPaid(uint256 indexed reportId, address indexed researcher, uint256 amount);

    error NotCouncil();
    error InvalidInput();
    error ConflictOfInterest();
    error AlreadyRegistered(address account);
    error UnknownCompany(address account);
    error NotActiveCompany();
    error InvalidHandle();
    error HandleTaken(string handle);
    error NotResearcher();
    error InvalidRewards();
    error InvalidWindow(uint256 minWindow, uint256 maxWindow);
    error InsufficientEscrow(uint256 needed, uint256 available);
    error UnknownProgram(uint256 programId);
    error UnknownReport(uint256 reportId);
    error NotProgramOwner();
    error ProgramNotOpen(uint256 programId);
    error DuplicateReport(uint256 existingReportId);
    error NotPending(uint256 reportId);
    error InvalidDuplicate();
    error NotReportResearcher();
    error CannotEscalate(uint256 reportId);
    error TooEarly(uint256 nowTime, uint256 allowedAt);
    error AppealWindowClosed(uint256 deadline);
    error NoOpenDispute(uint256 reportId);
    error ProgramHasOpenReports(uint256 openReports);
    error AppealsStillOpen(uint256 until);
    error TransferFailed();
    error Reentrancy();

    modifier onlyCouncil() {
        if (msg.sender != council) revert NotCouncil();
        _;
    }

    /// @dev Second line of defence next to checks-effects-interactions.
    modifier nonReentrant() {
        if (lock != 1) revert Reentrancy();
        lock = 2;
        _;
        lock = 1;
    }

    constructor() {
        council = msg.sender;
    }

    // ------------------------------------------------------------------
    // Membership: companies are admitted by the Council (permissioned),
    // researchers register themselves (permissionless).
    // ------------------------------------------------------------------

    function registerCompany(address account, string calldata name) external onlyCouncil {
        if (account == address(0) || bytes(name).length == 0) revert InvalidInput();
        if (account == council) revert ConflictOfInterest();
        if (companies[account].joinedAt != 0 || researchers[account].joinedAt != 0) revert AlreadyRegistered(account);
        companies[account] = Company(name, true, uint64(block.timestamp));
        companyList.push(account);
        emit CompanyRegistered(account, name);
    }

    function setCompanyActive(address account, bool active) external onlyCouncil {
        if (companies[account].joinedAt == 0) revert UnknownCompany(account);
        companies[account].active = active;
        emit CompanyStatusChanged(account, active);
    }

    /// @notice Anyone can join as a researcher, once, with a unique handle (3-32 bytes).
    function registerResearcher(string calldata handle) external {
        uint256 len = bytes(handle).length;
        if (len < 3 || len > 32) revert InvalidHandle();
        if (msg.sender == council) revert ConflictOfInterest();
        if (researchers[msg.sender].joinedAt != 0 || companies[msg.sender].joinedAt != 0) revert AlreadyRegistered(msg.sender);
        bytes32 key = keccak256(bytes(handle));
        if (handleOwner[key] != address(0)) revert HandleTaken(handle);

        handleOwner[key] = msg.sender;
        Researcher storage r = researchers[msg.sender];
        r.handle = handle;
        r.joinedAt = uint64(block.timestamp);
        researcherList.push(msg.sender);
        emit ResearcherRegistered(msg.sender, handle);
    }

    // ------------------------------------------------------------------
    // Bounty programs and escrow
    // ------------------------------------------------------------------

    /// @notice Open a bounty program. The ETH sent (msg.value) is locked as escrow and must
    ///         cover at least one Critical reward.
    /// @param publicKey RSA-OAEP public key (SPKI, base64); researchers encrypt reports with it
    /// @param rewards   reward in wei for Low, Medium, High, Critical (must not decrease)
    function createProgram(
        string calldata name,
        string calldata scope,
        string calldata publicKey,
        uint256[4] calldata rewards,
        uint64 responseWindow
    ) external payable returns (uint256 programId) {
        Company storage c = companies[msg.sender];
        if (c.joinedAt == 0 || !c.active) revert NotActiveCompany();
        if (bytes(name).length == 0 || bytes(publicKey).length == 0) revert InvalidInput();
        if (rewards[0] == 0) revert InvalidRewards();
        for (uint256 i = 1; i < 4; i++) {
            if (rewards[i] < rewards[i - 1]) revert InvalidRewards();
        }
        if (responseWindow < MIN_WINDOW || responseWindow > MAX_WINDOW) revert InvalidWindow(MIN_WINDOW, MAX_WINDOW);
        if (msg.value < rewards[3]) revert InsufficientEscrow(rewards[3], msg.value);

        programId = programs.length;
        Program storage p = programs.push();
        p.company = msg.sender;
        p.name = name;
        p.scope = scope;
        p.publicKey = publicKey;
        p.rewards = rewards;
        p.escrow = msg.value;
        p.responseWindow = responseWindow;
        p.createdAt = uint64(block.timestamp);
        p.open = true;
        emit ProgramCreated(programId, msg.sender, name, msg.value, responseWindow);
    }

    function topUp(uint256 programId) external payable {
        Program storage p = _ownedProgram(programId);
        if (!p.open) revert ProgramNotOpen(programId);
        if (msg.value == 0) revert InvalidInput();
        p.escrow += msg.value;
        emit ProgramToppedUp(programId, msg.value, p.escrow);
    }

    /// @notice Close a program and withdraw the remaining escrow. Only possible when no report
    ///         waits for an answer and every appeal window has ended, so a company cannot
    ///         run away with the money it may still owe.
    function closeProgram(uint256 programId) external nonReentrant {
        Program storage p = _ownedProgram(programId);
        if (!p.open) revert ProgramNotOpen(programId);
        if (p.openReports != 0) revert ProgramHasOpenReports(p.openReports);
        if (block.timestamp < p.appealsOpenUntil) revert AppealsStillOpen(p.appealsOpenUntil);

        uint256 refund = p.escrow;
        p.open = false; // effects first ...
        p.escrow = 0;
        emit ProgramClosed(programId, refund);
        _pay(msg.sender, refund); // ... interaction last
    }

    // ------------------------------------------------------------------
    // Reports
    // ------------------------------------------------------------------

    /// @notice Commit an encrypted report. The block time is the researcher's proof of priority.
    /// @param cipherHash sha256 of the encrypted package kept off-chain
    /// @param reportHash sha256 of the plaintext report (salted JSON); revealed later if disputed
    function submitReport(uint256 programId, bytes32 cipherHash, bytes32 reportHash, Severity claimed)
        external
        returns (uint256 reportId)
    {
        Researcher storage me = researchers[msg.sender];
        if (me.joinedAt == 0) revert NotResearcher();
        Program storage p = _program(programId);
        if (!p.open) revert ProgramNotOpen(programId);
        if (reportHash == bytes32(0) || cipherHash == bytes32(0) || reportHash == cipherHash) revert InvalidInput();
        if (hashIndex[reportHash] != 0) revert DuplicateReport(hashIndex[reportHash] - 1);
        if (hashIndex[cipherHash] != 0) revert DuplicateReport(hashIndex[cipherHash] - 1);

        reportId = reports.length;
        Report storage r = reports.push();
        r.programId = programId;
        r.researcher = msg.sender;
        r.reportHash = reportHash;
        r.cipherHash = cipherHash;
        r.claimed = claimed;
        r.submittedAt = uint64(block.timestamp);

        hashIndex[reportHash] = reportId + 1;
        hashIndex[cipherHash] = reportId + 1;
        programReports[programId].push(reportId);
        researcherReports[msg.sender].push(reportId);
        p.openReports += 1;
        p.reportCount += 1;
        me.submitted += 1;
        emit ReportSubmitted(reportId, programId, msg.sender, reportHash, cipherHash, claimed);
    }

    /// @notice Accept a report and pay rewards[severity] from escrow to the researcher.
    function acceptReport(uint256 reportId, Severity severity) external nonReentrant {
        (Report storage r, Program storage p) = _pendingForOwner(reportId);
        uint256 amount = p.rewards[uint256(severity)];
        if (p.escrow < amount) revert InsufficientEscrow(amount, p.escrow);

        r.status = Status.Accepted;
        r.respondedAt = uint64(block.timestamp);
        p.openReports -= 1;
        emit ReportAccepted(reportId, severity, amount);
        _payout(r, p, reportId, severity, amount);
    }

    function rejectReport(uint256 reportId, string calldata reason) external {
        (Report storage r, Program storage p) = _pendingForOwner(reportId);
        if (bytes(reason).length == 0) revert InvalidInput();
        r.status = Status.Rejected;
        r.reason = reason;
        uint64 appealDeadline = _answered(r, p);
        emit ReportRejected(reportId, reason, appealDeadline);
    }

    /// @notice "We already knew" must point to an EARLIER report on-chain in the same program.
    function markDuplicate(uint256 reportId, uint256 originalReportId) external {
        (Report storage r, Program storage p) = _pendingForOwner(reportId);
        if (originalReportId >= reportId || reports[originalReportId].programId != r.programId) revert InvalidDuplicate();
        r.status = Status.Duplicate;
        r.duplicateOf = originalReportId;
        uint64 appealDeadline = _answered(r, p);
        emit ReportMarkedDuplicate(reportId, originalReportId, appealDeadline);
    }

    // ------------------------------------------------------------------
    // Disputes: the Council is the neutral arbiter
    // ------------------------------------------------------------------

    /// @notice Escalate to the arbiter. Allowed when the company rejected the report or marked
    ///         it duplicate (within one response window), or ignored it past the deadline.
    function escalate(uint256 reportId) external {
        Report storage r = _report(reportId);
        if (msg.sender != r.researcher) revert NotReportResearcher();
        if (r.dispute != Dispute.None) revert CannotEscalate(reportId);
        Program storage p = programs[r.programId];

        if (r.status == Status.Pending) {
            uint256 deadline = uint256(r.submittedAt) + p.responseWindow;
            if (block.timestamp < deadline) revert TooEarly(block.timestamp, deadline);
            // still counted in openReports
        } else if (r.status == Status.Rejected || r.status == Status.Duplicate) {
            uint256 appealDeadline = uint256(r.respondedAt) + p.responseWindow;
            if (block.timestamp >= appealDeadline) revert AppealWindowClosed(appealDeadline);
            p.openReports += 1;
        } else {
            revert CannotEscalate(reportId); // accepted reports are already paid
        }

        r.dispute = Dispute.Open;
        r.escalatedAt = uint64(block.timestamp);
        emit ReportEscalated(reportId, msg.sender, r.status);
    }

    /// @notice The arbiter's final decision. In favour of the researcher, rewards[severity] is
    ///         paid from the program's escrow even if the company disagrees.
    function resolveDispute(uint256 reportId, bool inFavourOfResearcher, Severity severity)
        external
        onlyCouncil
        nonReentrant
    {
        Report storage r = _report(reportId);
        if (r.dispute != Dispute.Open) revert NoOpenDispute(reportId);
        Program storage p = programs[r.programId];
        uint256 amount = inFavourOfResearcher ? p.rewards[uint256(severity)] : 0;
        if (p.escrow < amount) revert InsufficientEscrow(amount, p.escrow);

        r.dispute = inFavourOfResearcher ? Dispute.ResearcherWon : Dispute.CompanyWon;
        r.resolvedAt = uint64(block.timestamp);
        p.openReports -= 1;
        emit DisputeResolved(reportId, inFavourOfResearcher, severity, amount);
        if (inFavourOfResearcher) _payout(r, p, reportId, severity, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function programCount() external view returns (uint256) {
        return programs.length;
    }

    function reportCount() external view returns (uint256) {
        return reports.length;
    }

    function getProgram(uint256 programId) external view returns (Program memory) {
        return _program(programId);
    }

    function getReport(uint256 reportId) external view returns (Report memory) {
        return _report(reportId);
    }

    function getProgramReports(uint256 programId) external view returns (uint256[] memory) {
        _program(programId);
        return programReports[programId];
    }

    function getResearcherReports(address researcher) external view returns (uint256[] memory) {
        return researcherReports[researcher];
    }

    /// @notice Response deadline of a report (submission time + the program's response window).
    function responseDeadline(uint256 reportId) external view returns (uint256) {
        Report storage r = _report(reportId);
        return uint256(r.submittedAt) + programs[r.programId].responseWindow;
    }

    /// @notice Proof of priority lookup: which report committed this reportHash or cipherHash?
    function findReport(bytes32 hash) external view returns (bool found, uint256 reportId) {
        uint256 idx = hashIndex[hash];
        if (idx == 0) return (false, 0);
        return (true, idx - 1);
    }

    function getCompanies() external view returns (address[] memory accounts, Company[] memory info) {
        accounts = companyList;
        info = new Company[](companyList.length);
        for (uint256 i = 0; i < companyList.length; i++) info[i] = companies[companyList[i]];
    }

    /// @notice All researchers with their earnings (for the leaderboard).
    function getResearchers() external view returns (address[] memory accounts, Researcher[] memory info) {
        accounts = researcherList;
        info = new Researcher[](researcherList.length);
        for (uint256 i = 0; i < researcherList.length; i++) info[i] = researchers[researcherList[i]];
    }

    /// @notice Total ETH held in escrow by the contract.
    function escrowBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    function _program(uint256 programId) private view returns (Program storage) {
        if (programId >= programs.length) revert UnknownProgram(programId);
        return programs[programId];
    }

    function _ownedProgram(uint256 programId) private view returns (Program storage p) {
        p = _program(programId);
        if (p.company != msg.sender) revert NotProgramOwner();
    }

    function _report(uint256 reportId) private view returns (Report storage) {
        if (reportId >= reports.length) revert UnknownReport(reportId);
        return reports[reportId];
    }

    /// @dev The caller must own the report's program and the report must still wait for an answer.
    function _pendingForOwner(uint256 reportId) private view returns (Report storage r, Program storage p) {
        r = _report(reportId);
        p = programs[r.programId];
        if (p.company != msg.sender) revert NotProgramOwner();
        if (r.status != Status.Pending || r.dispute != Dispute.None) revert NotPending(reportId);
    }

    /// @dev Records the company's answer. The researcher may appeal within one response window,
    ///      so the program's escrow stays locked at least until then.
    function _answered(Report storage r, Program storage p) private returns (uint64 appealDeadline) {
        r.respondedAt = uint64(block.timestamp);
        p.openReports -= 1;
        appealDeadline = uint64(block.timestamp) + p.responseWindow;
        if (appealDeadline > p.appealsOpenUntil) p.appealsOpenUntil = appealDeadline;
    }

    /// @dev Effects (all bookkeeping) first, then the ETH transfer.
    function _payout(Report storage r, Program storage p, uint256 reportId, Severity severity, uint256 amount) private {
        r.awarded = severity;
        r.payout = amount;
        p.escrow -= amount;
        p.paid += amount;
        totalPaid += amount;
        Researcher storage res = researchers[r.researcher];
        res.accepted += 1;
        res.earned += amount;
        emit BountyPaid(reportId, r.researcher, amount);
        _pay(r.researcher, amount);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
