/* BountyChain - Bug Bounty & Responsible Disclosure Platform (web app) */
(function () {
  const SEV = ["Low", "Medium", "High", "Critical"];
  const STATUS = { Pending: 0, Accepted: 1, Rejected: 2, Duplicate: 3 };
  const DISPUTE = { None: 0, Open: 1, ResearcherWon: 2, CompanyWon: 3 };

  // Demo consortium (fictional). Account 0 is the Disclosure Council: deployer, admin and arbiter.
  const COMPANIES = [
    [1, "PaySecure Bank (demo)"],
    [2, "CampusCloud"],
  ];
  const RESEARCHERS = [
    [3, "0xAnaya"],
    [4, "nullbyte_ravi"],
  ];
  const RESEARCHER_SLOTS = [3, 4, 5]; // account 5 registers itself during the demo (permissionless)
  const SUGGESTED_HANDLE = { 5: "kernel_kim", 7: "h4ck_hana", 8: "sec_sam", 9: "bytewise_bo" };
  const NEW_COMPANY = { account: 6, name: "ShopNest Retail (demo)" }; // admitted live by the Council

  const SAMPLE_PROGRAMS = {
    "PaySecure Bank (demo)": {
      name: "PaySecure Online Banking",
      scope: "bank.paysecure.example (web banking)\napi.paysecure.example/v2 (mobile API)\nOut of scope: denial of service, social engineering",
      rewards: ["0.5", "1", "2.5", "5"],
      escrow: "12",
      days: 3,
    },
    CampusCloud: {
      name: "CampusCloud Student Portal",
      scope: "portal.campuscloud.example\napi.campuscloud.example\nOut of scope: third-party payment pages",
      rewards: ["0.2", "0.5", "1", "2"],
      escrow: "6",
      days: 3,
    },
  };
  const DEFAULT_PROGRAM = { name: "Public Bug Bounty", scope: "*.shopnest.example", rewards: ["0.1", "0.25", "0.5", "1"], escrow: "3", days: 3 };

  // Built-in sample reports. All targets use the reserved .example domain (fictional).
  const SAMPLE_REPORTS = [
    {
      key: "idor",
      label: "IDOR",
      title: "IDOR on /api/accounts/{id} exposes other customers' accounts",
      asset: "https://api.paysecure.example/v2/accounts/{id}",
      severity: 2,
      steps:
        "1. Log in as test customer A and open Accounts.\n2. Capture GET /v2/accounts/100245 in an intercepting proxy.\n3. Change the id to 100246 (customer B) and resend it with A's session cookie.\n4. The API returns B's account number, balance and last 10 transactions.",
      impact: "Any logged-in customer can read every other customer's account details by changing a number. The server never checks who owns the account.",
    },
    {
      key: "xss",
      label: "Stored XSS",
      title: "Stored XSS in profile display name",
      asset: "https://portal.campuscloud.example/profile",
      severity: 1,
      steps:
        "1. Open Profile > Edit.\n2. Set the display name to: <img src=x onerror=alert(1)>\n3. Save, then open any discussion thread where the name is shown.\n4. The script runs in the browser of every student who views the thread.",
      impact: "An attacker can run JavaScript in other students' sessions, for example to post messages as them.",
    },
    {
      key: "jwt",
      label: "JWT 'none'",
      title: "JWT signed with 'none' algorithm is accepted",
      asset: "https://api.paysecure.example/v2/auth",
      severity: 3,
      steps:
        "1. Log in and copy the JWT from the Authorization header.\n2. Decode it, set \"alg\" to \"none\", change \"sub\" to another customer id and drop the signature.\n3. Send any API request with the forged token.\n4. The API accepts it and acts as the other customer.",
      impact: "Full takeover of any customer account, including payments. No user interaction needed.",
    },
    {
      key: "verbose",
      label: "Verbose errors",
      title: "Stack traces with internal hostnames on error pages",
      asset: "https://bank.paysecure.example/login",
      severity: 0,
      steps: "1. Send a login request with a malformed JSON body.\n2. The HTTP 500 response contains a full stack trace, the framework version and internal hostnames.",
      impact: "Information disclosure that helps an attacker plan further attacks.",
    },
  ];

  const ERRORS = {
    NotCouncil: () => "only the Disclosure Council (account 0) can do this.",
    InvalidInput: () => "some required information is missing or invalid.",
    ConflictOfInterest: () => "the arbiter cannot also be a company or a researcher.",
    AlreadyRegistered: () => "this account is already registered on the platform.",
    UnknownCompany: () => "this account is not a registered company.",
    NotActiveCompany: () => "only an active company admitted by the Disclosure Council can open a program.",
    InvalidHandle: () => "the handle must be 3 to 32 characters long.",
    HandleTaken: (h) => `the handle "${h}" is already taken.`,
    NotResearcher: () => "register a researcher handle first.",
    InvalidRewards: () => "rewards must be above zero and must not decrease from Low to Critical.",
    InvalidWindow: (min, max) => `the response window must be between ${fmtWindow(min)} and ${fmtWindow(max)}.`,
    InsufficientEscrow: (needed, available) =>
      `not enough escrow: ${fmtEth(needed)} is needed but only ${fmtEth(available)} is locked. Top up the program first.`,
    UnknownProgram: (id) => `program #${id} does not exist.`,
    UnknownReport: (id) => `report #${id} does not exist.`,
    NotProgramOwner: () => "only the company that owns this program can do this.",
    ProgramNotOpen: (id) => `program #${id} is closed.`,
    DuplicateReport: (id) => `this exact report was already submitted as report #${id}.`,
    NotPending: (id) => `report #${id} has already been decided or is with the arbiter.`,
    InvalidDuplicate: () => "the original must be an EARLIER report in the same program.",
    NotReportResearcher: () => "only the researcher who submitted the report can escalate it.",
    CannotEscalate: (id) => `report #${id} cannot be escalated (it was paid or is already escalated).`,
    TooEarly: (now, at) =>
      `too early! The company has until ${UI.fmtTime(at)} to respond (${UI.fmtDuration(Number(at) - Number(now))} from now). You can escalate after that deadline.`,
    AppealWindowClosed: (d) => `the appeal window closed at ${UI.fmtTime(d)}.`,
    NoOpenDispute: (id) => `report #${id} has no open dispute.`,
    ProgramHasOpenReports: (n) => `${n} report(s) still wait for an answer. Respond to them before closing the program.`,
    AppealsStillOpen: (until) => `researchers can still appeal until ${UI.fmtTime(until)}, so the escrow stays locked until then.`,
    TransferFailed: () => "the ETH transfer failed.",
    Reentrancy: () => "re-entrant call blocked.",
  };

  const lower = (a) => (a || "").toLowerCase();
  const sameAddr = (a, b) => lower(a) === lower(b);
  const council = () => Chain.accounts[0];
  const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

  function fmtEth(wei, digits = 4) {
    const n = Number(ethers.formatEther(wei));
    return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ETH`;
  }
  function fmtWindow(sec) {
    sec = Number(sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    if (d) return `${d} day${d > 1 ? "s" : ""}${h ? ` ${h} h` : ""}`;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const sevChip = (s) => `<span class="chip sev sev-${s}">${SEV[s]}</span>`;
  const countdown = (ts, done = "passed") =>
    `<strong data-countdown="${ts}" data-done-text="${done}">${UI.fmtDuration(ts - Chain.now())}</strong>`;

  const fingerprints = new Map();
  async function fingerprintOf(publicKey) {
    if (!fingerprints.has(publicKey)) fingerprints.set(publicKey, await BountyCrypto.fingerprint(publicKey));
    return fingerprints.get(publicKey);
  }

  // ------------------------------------------------------------------
  // Off-chain storage (simulated): the report server, company key vaults,
  // researchers' own plaintext copies and reports revealed to the arbiter.
  // ------------------------------------------------------------------
  const server = () => Chain.store.get("server", {}); // cipherHash -> encrypted package (JSON text)
  const copies = () => Chain.store.get("copies", {}); // reportHash -> researcher's plaintext report
  const evidence = () => Chain.store.get("evidence", {}); // reportId -> plaintext revealed to the arbiter
  const vaultOf = (addr) => Chain.store.get("vault", {})[lower(addr)] || {}; // programId -> PKCS#8 private key
  function putIn(name, key, value) {
    const all = Chain.store.get(name, {});
    all[key] = value;
    Chain.store.set(name, all);
  }
  function putKey(addr, programId, pkcs8) {
    const v = Chain.store.get("vault", {});
    v[lower(addr)] = v[lower(addr)] || {};
    v[lower(addr)][programId] = pkcs8;
    Chain.store.set("vault", v);
  }
  function titleOf(r) {
    const text = copies()[r.reportHash] || evidence()[r.id];
    if (!text) return null;
    try {
      return BountyCrypto.parseReport(text).title;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  async function load() {
    const c = Chain.contract;
    const A = Chain.accounts;
    A.forEach((a, i) => Chain.setName(a, i === 0 ? "Disclosure Council" : `Account #${i}`));
    const [[cAccts, cInfo], [rAccts, rInfo], pCount, rCount, totalPaid] = await Promise.all([
      c.getCompanies(),
      c.getResearchers(),
      c.programCount(),
      c.reportCount(),
      c.totalPaid(),
    ]);
    const companies = cAccts.map((a, i) => ({ address: a, name: cInfo[i].name, active: cInfo[i].active, joinedAt: Number(cInfo[i].joinedAt) }));
    const researchers = rAccts.map((a, i) => ({
      address: a,
      handle: rInfo[i].handle,
      joinedAt: Number(rInfo[i].joinedAt),
      submitted: Number(rInfo[i].submitted),
      accepted: Number(rInfo[i].accepted),
      earned: rInfo[i].earned,
    }));
    companies.forEach((x) => Chain.setName(x.address, x.name));
    researchers.forEach((x) => Chain.setName(x.address, x.handle));

    const programs = await Promise.all(
      Array.from({ length: Number(pCount) }, (_, id) =>
        c.getProgram(id).then((p) => ({
          id,
          company: p.company,
          name: p.name,
          scope: p.scope,
          publicKey: p.publicKey,
          rewards: [...p.rewards],
          escrow: p.escrow,
          paid: p.paid,
          responseWindow: Number(p.responseWindow),
          createdAt: Number(p.createdAt),
          appealsOpenUntil: Number(p.appealsOpenUntil),
          openReports: Number(p.openReports),
          reportCount: Number(p.reportCount),
          open: p.open,
        }))
      )
    );
    const reports = await Promise.all(
      Array.from({ length: Number(rCount) }, (_, id) =>
        c.getReport(id).then((r) => ({
          id,
          programId: Number(r.programId),
          researcher: r.researcher,
          reportHash: r.reportHash,
          cipherHash: r.cipherHash,
          claimed: Number(r.claimed),
          awarded: Number(r.awarded),
          status: Number(r.status),
          dispute: Number(r.dispute),
          submittedAt: Number(r.submittedAt),
          respondedAt: Number(r.respondedAt),
          escalatedAt: Number(r.escalatedAt),
          resolvedAt: Number(r.resolvedAt),
          duplicateOf: Number(r.duplicateOf),
          payout: r.payout,
          reason: r.reason,
        }))
      )
    );
    const bals = await Promise.all(A.map((a) => Chain.provider.getBalance(a)));
    const balances = {};
    A.forEach((a, i) => (balances[lower(a)] = bals[i]));
    const escrowTotal = await Chain.provider.getBalance(Chain.address);

    for (const p of programs) p.reports = reports.filter((r) => r.programId === p.id);
    for (const r of reports) {
      r.program = programs[r.programId];
      r.deadline = r.submittedAt + r.program.responseWindow;
      r.appealUntil = r.respondedAt ? r.respondedAt + r.program.responseWindow : 0;
    }
    return { companies, researchers, programs, reports, balances, escrowTotal, totalPaid, accounts: A };
  }

  /** Human status of a report, combining the company's decision and the dispute state. */
  function reportState(r) {
    if (r.dispute === DISPUTE.Open) return { key: "escalated", label: "With the arbiter", chip: "chip-warn" };
    if (r.dispute === DISPUTE.ResearcherWon) return { key: "awarded", label: "Awarded by arbiter", chip: "chip-ok" };
    if (r.dispute === DISPUTE.CompanyWon) return { key: "dismissed", label: "Dismissed by arbiter", chip: "chip-bad" };
    if (r.status === STATUS.Accepted) return { key: "accepted", label: "Accepted · paid", chip: "chip-ok" };
    if (r.status === STATUS.Rejected) return { key: "rejected", label: "Rejected", chip: "chip-bad" };
    if (r.status === STATUS.Duplicate) return { key: "duplicate", label: `Duplicate of #${r.duplicateOf}`, chip: "chip-bad" };
    if (Chain.now() >= r.deadline) return { key: "overdue", label: "Overdue · no response", chip: "chip-bad" };
    return { key: "pending", label: "Awaiting triage", chip: "chip-accent" };
  }

  const isAwaitingCompany = (r) => r.status === STATUS.Pending && r.dispute === DISPUTE.None;

  function canEscalate(r) {
    if (r.dispute !== DISPUTE.None) return false;
    const now = Chain.now();
    if (r.status === STATUS.Pending) return now >= r.deadline;
    if (r.status === STATUS.Rejected || r.status === STATUS.Duplicate) return now < r.appealUntil;
    return false;
  }

  // ------------------------------------------------------------------
  // Core actions
  // ------------------------------------------------------------------
  /** Company: generate an RSA key pair, lock the escrow and publish the program. */
  async function createProgram(company, f) {
    let keys, rewardsWei, escrowWei, result, programId;
    const host = document.getElementById("create-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Generate an RSA-OAEP 2048-bit key pair in this browser",
        run: async () => {
          keys = await BountyCrypto.generateKeyPair();
          return `Public key fingerprint (SHA-256) ${UI.short(keys.fingerprint, 8)}`;
        },
      },
      {
        title: "Prepare the public key and the reward table",
        run: async () => {
          rewardsWei = f.rewards.map((v) => ethers.parseEther(String(v)));
          escrowWei = ethers.parseEther(String(f.escrow));
          return `SPKI public key: ${keys.spkiBytes} bytes · rewards ${f.rewards.join(" / ")} ETH (Low / Medium / High / Critical)`;
        },
      },
      {
        title: `Lock ${f.escrow} ETH in escrow and publish the program (createProgram)`,
        run: async () => {
          result = await Chain.send(company, "createProgram", [
            f.name,
            f.scope,
            keys.publicKey,
            rewardsWei,
            Math.round(Number(f.days) * 86400),
            { value: escrowWei },
          ]);
          programId = Number(result.events.find((e) => e.name === "ProgramCreated").args.programId);
          return `Program #${programId} · block #${result.block.number} · ${f.escrow} ETH is now held by the smart contract`;
        },
      },
      {
        title: "Keep the private key in the company vault (off-chain)",
        run: async () => {
          putKey(company, programId, keys.privateKey);
          keys.privateKey = null;
          return "It never touches the blockchain. Download a .pem backup under My programs.";
        },
      },
    ]);
    Shell.state.createResult = { company, items: run.items };
    if (!run.ok) throw run.error;
    UI.toast(`"${f.name}" is live with ${f.escrow} ETH in escrow`, "success");
    return programId;
  }

  /** Researcher: encrypt the report for the company, commit its hashes, upload the ciphertext. */
  async function submitReport(researcher, f) {
    let program, plaintext, reportHash, enc, wrapped, pkg, cipherHash, result, reportId;
    const host = document.getElementById("submit-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Fetch the company's RSA public key from the blockchain",
        run: async () => {
          program = await Chain.contract.getProgram(f.programId);
          return `${program.name} · key fingerprint ${UI.short(await fingerprintOf(program.publicKey), 6)}`;
        },
      },
      {
        title: "Hash the salted report (SHA-256 commitment)",
        run: async () => {
          plaintext = BountyCrypto.canonicalReport({ ...f, salt: f.salt || UI.bytesToHex(UI.randomBytes(16)) });
          reportHash = await UI.sha256(plaintext);
          return `reportHash ${UI.short(reportHash, 8)} · the random salt makes it impossible to guess the content`;
        },
      },
      {
        title: "Encrypt the report with a fresh AES-256-GCM key",
        run: async () => {
          enc = await BountyCrypto.aesEncrypt(plaintext);
          return `${enc.ciphertext.length} encrypted bytes (incl. 16-byte auth tag) · random 96-bit IV`;
        },
      },
      {
        title: "Wrap the AES key with RSA-OAEP so only the company can open it",
        run: async () => {
          wrapped = await BountyCrypto.wrapKey(enc.rawKey, program.publicKey);
          enc.rawKey.fill(0);
          pkg = BountyCrypto.buildPackage({
            programId: f.programId,
            keyFingerprint: await fingerprintOf(program.publicKey),
            wrappedKey: wrapped,
            iv: enc.iv,
            ciphertext: enc.ciphertext,
          });
          cipherHash = await UI.sha256(pkg);
          return `${wrapped.length}-byte wrapped key · package hash ${UI.short(cipherHash, 8)}`;
        },
      },
      {
        title: "Commit both hashes on the blockchain (submitReport)",
        run: async () => {
          result = await Chain.send(researcher, "submitReport", [Number(f.programId), cipherHash, reportHash, Number(f.severity)]);
          reportId = Number(result.events.find((e) => e.name === "ReportSubmitted").args.reportId);
          return `Report #${reportId} · block #${result.block.number} · ${UI.fmtTime(result.block.timestamp)}: your proof of priority`;
        },
      },
      {
        title: "Upload the encrypted package to the report server (off-chain)",
        run: async () => {
          putIn("server", cipherHash, pkg);
          putIn("copies", reportHash, plaintext);
          return "Only the company's private key can decrypt it. Your plain copy stays in your browser.";
        },
      },
    ]);
    Shell.state.submitResult = { researcher, items: run.items };
    if (!run.ok) throw run.error;
    UI.toast(`Report #${reportId} committed on-chain. The bug stays private.`, "success");
    return reportId;
  }

  /** Company: fetch, verify and decrypt a report with the program's private key. */
  async function decryptReport(company, report) {
    let pkg, parsed, priv, rawKey, plaintext;
    const p = report.program;
    const host = document.getElementById("inbox-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Download the encrypted package from the report server",
        run: async () => {
          pkg = server()[report.cipherHash];
          if (!pkg) throw new Error('The encrypted package is not in this browser. Use "Import package".');
          parsed = BountyCrypto.parsePackage(pkg);
          return `${pkg.length} bytes · ${BountyCrypto.ALG}`;
        },
      },
      {
        title: "Check its SHA-256 against the cipherHash on the blockchain",
        run: async () => {
          const h = await UI.sha256(pkg);
          if (h !== report.cipherHash) throw new Error("Hash mismatch: the package was modified after it was committed.");
          return `${UI.short(h, 8)} ✓ matches report #${report.id}`;
        },
      },
      {
        title: "Unwrap the AES key with the program's RSA private key (vault)",
        run: async () => {
          priv = vaultOf(company)[p.id];
          if (!priv) throw new Error('The private key of this program is not in this browser. Import the .pem backup under "My programs".');
          rawKey = await BountyCrypto.unwrapKey(parsed.wrappedKey, priv);
          return `AES-${rawKey.length * 8} key recovered with RSA-OAEP`;
        },
      },
      {
        title: "Decrypt the report with AES-256-GCM (authentication tag checked)",
        run: async () => {
          plaintext = await BountyCrypto.aesDecrypt(rawKey, parsed.iv, parsed.ciphertext);
          rawKey.fill(0);
          return `${plaintext.length} characters decrypted`;
        },
      },
      {
        title: "Check the report's SHA-256 against the reportHash on the blockchain",
        run: async () => {
          const h = await UI.sha256(plaintext);
          if (h !== report.reportHash) throw new Error("Hash mismatch: this is not the report the researcher committed.");
          return `${UI.short(h, 8)} ✓ exactly what the researcher committed`;
        },
      },
      {
        title: "Proof of priority",
        run: async () => {
          const earlier = p.reports.filter((x) => x.id < report.id).length;
          return `Committed by ${Chain.label(report.researcher)} at ${UI.fmtTime(report.submittedAt)} (block time) · ${earlier} earlier report(s) in this program`;
        },
      },
    ]);
    const obj = run.ok ? BountyCrypto.parseReport(plaintext) : null;
    Shell.state.opened = { reportId: report.id, company, items: run.items, report: obj };
    if (!run.ok) throw run.error;
    Shell.state.titles = { ...(Shell.state.titles || {}), [report.id]: obj.title };
  }

  async function acceptReport(company, reportId, severity) {
    const { events } = await Chain.send(company, "acceptReport", [reportId, severity]);
    const paid = events.find((e) => e.name === "BountyPaid");
    UI.toast(`Report #${reportId} accepted: ${fmtEth(paid.args.amount)} paid automatically to ${Chain.label(paid.args.researcher)}`, "success");
  }

  async function rejectReport(company, reportId, reason) {
    await Chain.send(company, "rejectReport", [reportId, reason]);
    UI.toast(`Report #${reportId} rejected. The researcher can appeal to the arbiter.`, "success");
  }

  async function markDuplicate(company, reportId, originalId) {
    await Chain.send(company, "markDuplicate", [reportId, originalId]);
    UI.toast(`Report #${reportId} marked as duplicate of #${originalId}`, "success");
  }

  /** Researcher: escalate to the arbiter and reveal the report (commit-reveal) for review. */
  async function escalate(researcher, reportId) {
    const r = await Chain.contract.getReport(reportId);
    await Chain.send(researcher, "escalate", [reportId]);
    const copy = copies()[r.reportHash];
    if (copy) putIn("evidence", reportId, copy);
    UI.toast(
      copy
        ? `Report #${reportId} escalated. Your report was revealed to the Disclosure Council for review.`
        : `Report #${reportId} escalated. Send the report file to the Council so it can be verified.`,
      "success",
      6000
    );
  }

  /** Arbiter: check the revealed report against the on-chain commitment. */
  async function verifyEvidence(report, data) {
    let text, obj;
    const host = document.getElementById("verify-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Load the report revealed by the researcher",
        run: async () => {
          text = evidence()[report.id];
          if (!text) throw new Error('The researcher has not revealed this report in this browser. Use "Import revealed report".');
          obj = BountyCrypto.parseReport(text);
          return `"${obj.title}"`;
        },
      },
      {
        title: "Check its SHA-256 against the reportHash committed on-chain",
        run: async () => {
          const h = await UI.sha256(text);
          if (h !== report.reportHash) throw new Error("Hash mismatch: the revealed text is not what was committed.");
          return `${UI.short(h, 8)} ✓ committed at ${UI.fmtTime(report.submittedAt)}, unchanged since`;
        },
      },
      {
        title: "Check the report belongs to this program",
        run: async () => {
          if (Number(obj.programId) !== report.programId) throw new Error(`The report names program #${obj.programId}`);
          return `${report.program.name} · claimed ${SEV[report.claimed]}`;
        },
      },
      {
        title: report.status === STATUS.Duplicate ? "Compare with the original (priority)" : "Check the company's response time",
        run: async () => {
          if (report.status === STATUS.Duplicate) {
            const o = data.reports[report.duplicateOf];
            return `Original #${o.id} by ${Chain.label(o.researcher)} at ${UI.fmtTime(o.submittedAt)} · ${UI.fmtDuration(
              report.submittedAt - o.submittedAt
            )} earlier`;
          }
          if (report.status === STATUS.Rejected) return `Rejected at ${UI.fmtTime(report.respondedAt)}: "${report.reason}"`;
          return `No response by ${UI.fmtTime(report.deadline)} (deadline passed)`;
        },
      },
    ]);
    Shell.state.verified = { reportId: report.id, items: run.items, report: run.ok ? obj : null };
    if (!run.ok) throw run.error;
  }

  async function resolveDispute(reportId, inFavour, severity) {
    const { events } = await Chain.send(council(), "resolveDispute", [reportId, inFavour, severity]);
    const paid = events.find((e) => e.name === "BountyPaid");
    UI.toast(
      inFavour ? `Ruled for the researcher: ${fmtEth(paid.args.amount)} forced from escrow to ${Chain.label(paid.args.researcher)}` : `Dispute on report #${reportId} dismissed`,
      "success",
      6000
    );
  }

  /** Anyone: is this exact report (or encrypted package) committed on-chain, by whom and when? */
  async function checkPriority(text, data) {
    let hash, found, report, kind;
    const host = document.getElementById("priority-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Compute the SHA-256 of the file",
        run: async () => {
          if (!text) throw new Error("Paste or load a report first.");
          hash = await UI.sha256(text);
          return hash;
        },
      },
      {
        title: "Look the hash up on the blockchain (findReport)",
        run: async () => {
          const res = await Chain.contract.findReport(hash);
          if (!res.found) throw new Error("No report on this blockchain has this hash. The text was changed after it was committed, or it was never submitted.");
          found = Number(res.reportId);
          report = data.reports[found];
          kind = report.reportHash === hash ? "plaintext report (reportHash)" : "encrypted package (cipherHash)";
          return `Matches report #${found} · ${kind}`;
        },
      },
      {
        title: "Read the timestamped on-chain record",
        run: async () =>
          `Committed by ${Chain.label(report.researcher)} (${UI.short(report.researcher, 4)}) to "${report.program.name}" at ${UI.fmtTime(report.submittedAt)}`,
      },
      {
        title: "Priority within the program",
        run: async () => {
          const sameProgram = report.program.reports;
          const rank = sameProgram.findIndex((x) => x.id === report.id) + 1;
          return `Report ${rank} of ${sameProgram.length} in this program. Anyone who reports later cannot claim to have been first.`;
        },
      },
    ]);
    // "No match" is an expected answer (e.g. after tampering), so it is shown, not thrown.
    Shell.state.priority = { items: run.items, ok: run.ok, reportId: found };
    if (run.ok) UI.toast(`Match: report #${found}, committed by ${Chain.label(report.researcher)}`, "success");
    else UI.toast(run.error.message, "error", 6000);
    return { ok: run.ok, hash, reportId: run.ok ? found : null, kind };
  }

  // ------------------------------------------------------------------
  // Shared view pieces
  // ------------------------------------------------------------------
  const pageHead = (title, sub, actions = "") =>
    `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="row">${actions}</div></div>`;

  const rewardGrid = (p) =>
    `<div class="rewards">${p.rewards
      .map((w, i) => `<div class="reward">${sevChip(i)}<span class="amt">${UI.esc(fmtEth(w))}</span></div>`)
      .join("")}</div>`;

  function reportView(obj) {
    return `<div class="report-view">
      <div class="small muted">Decrypted report</div>
      <h3>${UI.esc(obj.title)}</h3>
      <div class="kv"><span>Affected asset</span><code>${UI.esc(obj.asset)}</code></div>
      <div class="kv"><span>Claimed severity</span>${sevChip(Number(obj.severity))}</div>
      <div class="label">Steps to reproduce</div><pre>${UI.esc(obj.steps)}</pre>
      <div class="label">Impact</div><pre>${UI.esc(obj.impact)}</pre>
    </div>`;
  }

  function timeline(r) {
    const now = Chain.now();
    const steps = [{ cls: "done", title: "Committed on-chain", detail: UI.fmtTime(r.submittedAt) }];
    if (r.status === STATUS.Accepted) {
      steps.push({ cls: "done", title: `Accepted as ${SEV[r.awarded]}`, detail: UI.fmtTime(r.respondedAt) });
      steps.push({ cls: "done", title: `${fmtEth(r.payout)} paid`, detail: "automatically from escrow" });
    } else {
      if (r.status === STATUS.Rejected) steps.push({ cls: "bad", title: "Rejected by company", detail: `"${r.reason}"` });
      else if (r.status === STATUS.Duplicate) steps.push({ cls: "bad", title: `Marked duplicate of #${r.duplicateOf}`, detail: UI.fmtTime(r.respondedAt) });
      else if (now < r.deadline && r.dispute === DISPUTE.None)
        steps.push({ cls: "current", title: "Awaiting company", html: `due ${UI.esc(UI.fmtTime(r.deadline))} · ${countdown(r.deadline)}` });
      else steps.push({ cls: "bad", title: "No response by deadline", detail: UI.fmtTime(r.deadline) });

      if (r.dispute !== DISPUTE.None) steps.push({ cls: "done", title: "Escalated to arbiter", detail: UI.fmtTime(r.escalatedAt) });
      else if (canEscalate(r))
        steps.push({
          cls: "current",
          title: "Escalation possible",
          html: r.status === STATUS.Pending ? "the company missed its deadline" : `appeal closes in ${countdown(r.appealUntil, "closed")}`,
        });
      else if (r.status !== STATUS.Pending) steps.push({ cls: "", title: "Appeal window closed", detail: UI.fmtTime(r.appealUntil) });
      else steps.push({ cls: "", title: "Escalate if ignored", detail: "opens at the deadline" });

      if (r.dispute === DISPUTE.Open) steps.push({ cls: "current", title: "Arbiter reviewing", detail: "Disclosure Council" });
      else if (r.dispute === DISPUTE.ResearcherWon)
        steps.push({ cls: "done", title: `Arbiter awarded ${SEV[r.awarded]}`, detail: `${fmtEth(r.payout)} forced from escrow` });
      else if (r.dispute === DISPUTE.CompanyWon) steps.push({ cls: "bad", title: "Arbiter dismissed it", detail: UI.fmtTime(r.resolvedAt) });
      else steps.push({ cls: "", title: "Arbiter decision", detail: "only if escalated" });
    }
    return `<ol class="timeline" style="--n:${steps.length}">${steps
      .map(
        (s) =>
          `<li class="${s.cls}"><span class="tl-title">${UI.esc(s.title)}</span><span class="tl-detail">${s.html || UI.esc(s.detail || "")}</span></li>`
      )
      .join("")}</ol>`;
  }

  function programsTable(programs) {
    if (!programs.length) return `<div class="empty">No bounty programs yet. Create one as a company.</div>`;
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Program</th><th>Top reward</th><th>Escrow</th><th>Reports</th><th>Status</th></tr></thead>
      <tbody>${programs
        .map(
          (p) => `<tr>
          <td data-label="Program"><strong>${UI.esc(p.name)}</strong><div class="muted small">${UI.esc(Chain.label(p.company))}</div></td>
          <td data-label="Top reward">${UI.esc(fmtEth(p.rewards[3]))}<div class="muted small">Critical</div></td>
          <td data-label="Escrow">${UI.esc(fmtEth(p.escrow))}</td>
          <td data-label="Reports">${p.reportCount}<div class="muted small">${p.openReports} open</div></td>
          <td data-label="Status">${p.open ? `<span class="chip chip-ok">Open</span>` : `<span class="chip">Closed</span>`}</td>
        </tr>`
        )
        .join("")}</tbody></table></div>`;
  }

  const miniStats = (items) =>
    `<div class="mini-stats">${items.map(([label, value]) => `<div><span class="mini-label">${label}</span><span class="mini-value">${value}</span></div>`).join("")}</div>`;

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  async function viewHome(el, { data, state, go }) {
    const ps = data.programs;
    const openCount = ps.filter((p) => p.open).length;
    const locked = ps.reduce((s, p) => s + p.escrow, 0n);
    const waiting = data.reports.filter((r) => ["pending", "overdue", "escalated"].includes(reportState(r).key)).length;

    el.innerHTML = `
      ${pageHead(
        "Bug Bounty &amp; Responsible Disclosure",
        "Researchers prove who found a bug first with a timestamped hash on the blockchain, without revealing the bug. Rewards are locked in a smart-contract escrow and paid automatically when a company accepts a report. Rejected or ignored reports go to a neutral arbiter.",
        `<button class="btn" id="sample-program-btn">${Shell.icon("building")} Create sample program</button>`
      )}
      <div class="grid-4" style="margin-bottom:16px">
        <div class="card stat"><span class="stat-value">${openCount}</span><span class="stat-label">Open bounty programs</span></div>
        <div class="card stat"><span class="stat-value">${UI.esc(fmtEth(locked, 2))}</span><span class="stat-label">Locked in escrow (test ETH)</span></div>
        <div class="card stat"><span class="stat-value">${data.reports.length}</span><span class="stat-label">Reports committed · ${waiting} open</span></div>
        <div class="card stat"><span class="stat-value">${UI.esc(fmtEth(data.totalPaid, 2))}</span><span class="stat-label">Paid to researchers</span></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>How it works</h2></div>
        <div class="flow" style="--steps:4">
          <div class="flow-step"><h3>Lock the bounty</h3><p>A company admitted by the Council opens a program: rewards go into the smart-contract escrow and its RSA public key is published.</p></div>
          <div class="flow-step"><h3>Encrypt &amp; commit</h3><p>The researcher encrypts the report (RSA-OAEP + AES-256-GCM). Only two SHA-256 hashes go on-chain: a timestamped proof of who was first.</p></div>
          <div class="flow-step"><h3>Triage &amp; auto-pay</h3><p>The company decrypts the report and checks the hashes. Accepting it pays the reward from escrow automatically.</p></div>
          <div class="flow-step"><h3>Escalate</h3><p>Rejected, "duplicate" or ignored past the deadline? The researcher escalates and the neutral arbiter can force payout.</p></div>
        </div>
      </div>
      <div class="grid-2" style="align-items:start">
        <div class="card"><div class="card-head"><h2>Bounty programs</h2><a href="#/programs" class="small">View all</a></div>${programsTable(ps)}</div>
        <div class="card">
          <div class="card-head"><h2>Demo script (5 minutes)</h2></div>
          <ol class="demo-list">
            <li><a href="#/company">Company</a> (PaySecure Bank): <em>Create sample program</em>. An RSA key pair is generated and 12 ETH is locked in escrow.</li>
            <li><a href="#/researcher">Researcher</a> 0xAnaya: load the <strong>IDOR</strong> sample, <em>Encrypt &amp; submit</em>. Only hashes go on-chain.</li>
            <li>Researcher nullbyte_ravi: submit the <strong>JWT</strong> sample, then <em>Escalate</em> it under My reports. The contract says <strong>too early</strong>.</li>
            <li>Company inbox: <em>Decrypt &amp; read</em> report #0 and accept it as High. 2.5 ETH is paid automatically.</li>
            <li>nullbyte_ravi: <em>Jump past deadline</em> (the company ignored the report), then <em>Escalate</em>.</li>
            <li><a href="#/council">Disclosure Council</a>: verify the revealed report and rule for the researcher. 5 ETH is forced from escrow.</li>
            <li><a href="#/leaderboard">Leaderboard</a>, <a href="#/priority">Proof of Priority</a> and the <a href="#/explorer">Blockchain Explorer</a>.</li>
          </ol>
        </div>
      </div>`;

    el.querySelector("#sample-program-btn").addEventListener("click", () => {
      const pay = data.companies.find((c) => c.name === COMPANIES[0][1]) || data.companies[0];
      if (pay) state.company = pay.address;
      state.prefillProgram = true;
      state.companyTab = "new";
      go("company");
    });
  }

  async function viewPrograms(el, { data, state, go }) {
    const ps = data.programs;
    const fps = await Promise.all(ps.map((p) => fingerprintOf(p.publicKey)));
    el.innerHTML = `
      ${pageHead(
        "Bounty Programs",
        "Public list of programs. The rewards are already locked in the smart contract, so a researcher can see that the money exists before reporting anything."
      )}
      ${
        ps.length
          ? `<div class="grid-2" style="align-items:start">${ps
              .map(
                (p, i) => `<div class="card">
              <div class="card-head"><div><h2>${UI.esc(p.name)}</h2><div class="muted small">${UI.esc(Chain.label(p.company))} · program #${p.id}</div></div>
                ${p.open ? `<span class="chip chip-ok">Open</span>` : `<span class="chip">Closed</span>`}</div>
              ${rewardGrid(p)}
              <div class="kv" style="margin-top:12px"><span>Scope</span><span class="pre-line">${UI.esc(p.scope || "-")}</span></div>
              <div class="kv"><span>Escrow locked</span><strong>${UI.esc(fmtEth(p.escrow))}</strong></div>
              <div class="kv"><span>Paid out</span><span>${UI.esc(fmtEth(p.paid))}</span></div>
              <div class="kv"><span>Response window</span><span>${fmtWindow(p.responseWindow)}</span></div>
              <div class="kv"><span>Reports</span><span>${p.reportCount} submitted · ${p.openReports} waiting for an answer</span></div>
              <div class="kv"><span>RSA public key</span><code title="${UI.esc(fps[i])}">${UI.esc(UI.short(fps[i], 6))}</code></div>
              <div class="row" style="margin-top:10px">
                ${p.open ? `<button class="btn" data-report="${p.id}">${Shell.icon("bug")} Submit a report</button>` : ""}
                <button class="btn btn-secondary btn-sm" data-pub="${p.id}">Download public key</button>
              </div>
            </div>`
              )
              .join("")}</div>`
          : `<div class="card empty">No bounty programs yet. <a href="#/company">Create one as a company</a>.</div>`
      }`;

    el.querySelectorAll("[data-report]").forEach((b) =>
      b.addEventListener("click", () => {
        state.submitProgram = Number(b.dataset.report);
        state.researcherTab = "submit";
        go("researcher");
      })
    );
    el.querySelectorAll("[data-pub]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = ps[Number(b.dataset.pub)];
        UI.download(`${slug(p.name)}-public-key.pem`, BountyCrypto.toPem(p.publicKey, "PUBLIC KEY"));
      })
    );
  }

  async function viewCompany(el, { data, state, action }) {
    if (!data.companies.length) return (el.innerHTML = `<div class="card empty">No companies registered.</div>`);
    if (!data.companies.some((c) => sameAddr(c.address, state.company))) state.company = data.companies[0].address;
    const me = data.companies.find((c) => sameAddr(c.address, state.company));
    const mine = data.programs.filter((p) => sameAddr(p.company, me.address));
    const inbox = data.reports.filter((r) => sameAddr(r.program.company, me.address)); // oldest first = priority order
    const awaiting = inbox.filter(isAwaitingCompany).length;
    const prefill = state.prefillProgram;
    state.prefillProgram = false;
    let tab = state.companyTab || (mine.length ? "inbox" : "new");
    if (!["inbox", "programs", "new"].includes(tab)) tab = "inbox";
    state.companyTab = tab;
    const locked = mine.reduce((s, p) => s + p.escrow, 0n);
    const paid = mine.reduce((s, p) => s + p.paid, 0n);

    let body = "";
    if (tab === "inbox") body = companyInbox(me, inbox, state);
    else if (tab === "programs") body = await companyPrograms(me, mine);
    else body = companyNew(me, state, prefill);

    el.innerHTML = `
      ${pageHead(
        "Company",
        "A company (admitted by the Disclosure Council) runs bounty programs: it locks rewards in escrow, decrypts reports with its private key and decides on them. Accepting pays automatically."
      )}
      <div class="segmented" style="margin-bottom:12px" role="tablist" aria-label="Company">${data.companies
        .map(
          (c) =>
            `<button type="button" role="tab" data-company="${c.address}" class="${sameAddr(c.address, me.address) ? "active" : ""}">${UI.esc(c.name)}</button>`
        )
        .join("")}</div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head" style="margin-bottom:8px"><h2>${UI.esc(me.name)}</h2>${me.active ? `<span class="chip chip-ok">Active member</span>` : `<span class="chip chip-bad">Suspended by the Council</span>`}</div>
        ${miniStats([
          ["Account", `<code>${UI.esc(UI.short(me.address, 4))}</code>`],
          ["Wallet balance", UI.esc(fmtEth(data.balances[lower(me.address)] || 0n))],
          ["Locked in escrow", UI.esc(fmtEth(locked))],
          ["Paid to researchers", UI.esc(fmtEth(paid))],
          ["Programs", String(mine.length)],
        ])}
      </div>
      <div class="segmented" style="margin-bottom:16px" role="tablist" aria-label="Company sections">
        <button type="button" role="tab" data-ctab="inbox" class="${tab === "inbox" ? "active" : ""}">Inbox${awaiting ? ` <span class="badge">${awaiting}</span>` : ""}</button>
        <button type="button" role="tab" data-ctab="programs" class="${tab === "programs" ? "active" : ""}">My programs (${mine.length})</button>
        <button type="button" role="tab" data-ctab="new" class="${tab === "new" ? "active" : ""}">New program</button>
      </div>
      ${body}`;

    el.querySelectorAll("[data-company]").forEach((b) =>
      b.addEventListener("click", () => {
        state.company = b.dataset.company;
        state.companyTab = null;
        Shell.render();
      })
    );
    el.querySelectorAll("[data-ctab]").forEach((b) =>
      b.addEventListener("click", () => {
        state.companyTab = b.dataset.ctab;
        Shell.render();
      })
    );
    if (tab === "inbox") bindInbox(el, me, data, state, action);
    else if (tab === "programs") bindPrograms(el, me, mine, action);
    else bindNew(el, me, state, action);
  }

  function companyInbox(me, inbox, state) {
    const opened = state.opened && sameAddr(state.opened.company, me.address) ? state.opened : null;
    const cur = opened ? inbox.find((r) => r.id === opened.reportId) : null;
    const list = inbox.length
      ? inbox
          .map((r) => {
            const st = reportState(r);
            const title = (state.titles || {})[r.id] || null; // known only after this company decrypted it
            return `<div class="card inbox-item ${cur && cur.id === r.id ? "selected" : ""}">
              <div class="card-head" style="margin-bottom:8px"><div><h3>Report #${r.id}</h3><div class="muted small">${UI.esc(r.program.name)}</div></div><span class="chip ${st.chip}">${UI.esc(st.label)}</span></div>
              <div class="inbox-title">${title ? UI.esc(title) : `<span class="muted">Encrypted report · decrypt to read the title</span>`}</div>
              <div class="kv"><span>Researcher</span><span>${UI.esc(Chain.label(r.researcher))}</span></div>
              <div class="kv"><span>Claimed</span>${sevChip(r.claimed)}</div>
              <div class="kv"><span>Submitted</span><span>${UI.fmtTime(r.submittedAt)}</span></div>
              ${isAwaitingCompany(r) ? `<div class="kv"><span>Respond by</span><span>${UI.fmtTime(r.deadline)} · ${countdown(r.deadline, "overdue")}</span></div>` : ""}
              <div class="row" style="margin-top:8px">
                <button class="btn btn-sm" data-decrypt="${r.id}">${Shell.icon("key")} Decrypt &amp; read</button>
                ${server()[r.cipherHash] ? `<button class="btn btn-ghost btn-sm" data-dlpkg="${r.id}">Download package</button>` : `<label class="btn btn-secondary btn-sm">Import package<input type="file" accept=".json,application/json" data-pkgimport="${r.id}" hidden></label>`}
              </div>
            </div>`;
          })
          .join("")
      : `<div class="card empty">No reports yet. Researchers' encrypted reports will appear here.</div>`;

    let viewer = `<p class="muted">Choose a report and click <em>Decrypt &amp; read</em>. The package is checked against the hashes on the blockchain, then opened with the program's private key.</p>`;
    if (opened && cur) {
      viewer = `<div id="inbox-steps">${UI.checklist(opened.items)}</div>`;
      if (opened.report) {
        viewer += reportView(opened.report);
        if (isAwaitingCompany(cur)) {
          const p = cur.program;
          const earlier = p.reports.filter((x) => x.id < cur.id);
          viewer += `<div class="triage">
            <div><div class="label">Accept and pay from escrow</div>
              <div class="inline-form"><select id="accept-sev" aria-label="Final severity">${SEV.map(
                (s, i) => `<option value="${i}" ${i === cur.claimed ? "selected" : ""}>${s} · ${UI.esc(fmtEth(p.rewards[i]))}</option>`
              ).join("")}</select>
              <button class="btn" id="accept-btn">${Shell.icon("coins")} Accept &amp; pay ${UI.esc(fmtEth(p.rewards[cur.claimed]))}</button></div>
              <span class="hint">Escrow left: ${UI.esc(fmtEth(p.escrow))}</span></div>
            <div><div class="label">Reject (reason is public, keep it generic)</div>
              <div class="inline-form"><input type="text" id="reject-reason" aria-label="Rejection reason" value="Out of scope" maxlength="120">
              <button class="btn btn-danger" id="reject-btn">Reject</button></div></div>
            <div><div class="label">Duplicate of an earlier report</div>
              <div class="inline-form"><select id="dup-select" aria-label="Original report" ${earlier.length ? "" : "disabled"}>${
                earlier.length
                  ? earlier.map((x) => `<option value="${x.id}">#${x.id} by ${UI.esc(Chain.label(x.researcher))} · ${UI.fmtTime(x.submittedAt)}</option>`).join("")
                  : `<option>No earlier report in this program</option>`
              }</select>
              <button class="btn btn-secondary" id="dup-btn" ${earlier.length ? "" : "disabled"}>Mark duplicate</button></div>
              <span class="hint">"We already knew" only counts if an earlier report is on the blockchain.</span></div>
          </div>`;
        } else {
          const st = reportState(cur);
          viewer += `<div class="callout ${st.chip === "chip-ok" ? "callout-ok" : st.chip === "chip-bad" ? "callout-bad" : "callout-warn"}" style="margin-top:14px"><strong>${UI.esc(st.label)}.</strong> ${
            cur.payout > 0n ? `${UI.esc(fmtEth(cur.payout))} was paid to ${UI.esc(Chain.label(cur.researcher))}.` : cur.dispute === DISPUTE.Open ? "The Disclosure Council will decide." : "No payment."
          }</div>`;
        }
      }
    }
    return `<div class="grid-2" style="align-items:start">
      <div class="stack" id="inbox-list">${list}</div>
      <div class="card" id="viewer"><div class="card-head"><h2 id="viewer-title">${cur ? `Report #${cur.id}` : "Report viewer"}</h2></div><div id="viewer-body">${viewer}</div></div>
    </div>`;
  }

  function bindInbox(el, me, data, state, action) {
    el.querySelectorAll("[data-decrypt]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = data.reports[Number(b.dataset.decrypt)];
        el.querySelector("#viewer-title").textContent = `Report #${r.id}`;
        el.querySelector("#viewer-body").innerHTML = `<div id="inbox-steps"></div>`;
        action(b, () => decryptReport(me.address, r));
      })
    );
    el.querySelectorAll("[data-dlpkg]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = data.reports[Number(b.dataset.dlpkg)];
        UI.download(`report-${r.id}-encrypted.json`, server()[r.cipherHash], "application/json");
      })
    );
    el.querySelectorAll("[data-pkgimport]").forEach((inp) =>
      inp.addEventListener("change", async () => {
        const r = data.reports[Number(inp.dataset.pkgimport)];
        const text = await UI.readFileText(inp.files[0]);
        if ((await UI.sha256(text)) !== r.cipherHash) return UI.toast("This file does not match the report's cipherHash on the blockchain", "error", 6000);
        putIn("server", r.cipherHash, text);
        UI.toast("Encrypted package imported and verified against the blockchain", "success");
        Shell.render();
      })
    );
    const opened = state.opened;
    const sev = el.querySelector("#accept-sev");
    const accept = el.querySelector("#accept-btn");
    if (sev && accept) {
      const p = data.reports[opened.reportId].program;
      sev.addEventListener("change", () => {
        accept.innerHTML = `${Shell.icon("coins")} Accept &amp; pay ${UI.esc(fmtEth(p.rewards[Number(sev.value)]))}`;
      });
      accept.addEventListener("click", () => action(accept, () => acceptReport(me.address, opened.reportId, Number(sev.value))));
    }
    const rb = el.querySelector("#reject-btn");
    if (rb)
      rb.addEventListener("click", () => {
        const reason = el.querySelector("#reject-reason").value.trim();
        if (!reason) return UI.toast("Give a short reason", "error");
        action(rb, () => rejectReport(me.address, opened.reportId, reason));
      });
    const db = el.querySelector("#dup-btn");
    if (db) db.addEventListener("click", () => action(db, () => markDuplicate(me.address, opened.reportId, Number(el.querySelector("#dup-select").value))));
  }

  async function companyPrograms(me, mine) {
    if (!mine.length) return `<div class="card empty">No programs yet. Open one under <em>New program</em>.</div>`;
    const vault = vaultOf(me.address);
    const fps = await Promise.all(mine.map((p) => fingerprintOf(p.publicKey)));
    return `<div class="grid-2" style="align-items:start">${mine
      .map((p, i) => {
        const hasKey = !!vault[p.id];
        const appeals = p.appealsOpenUntil > Chain.now();
        return `<div class="card">
          <div class="card-head"><div><h2>${UI.esc(p.name)}</h2><div class="muted small">Program #${p.id} · opened ${UI.fmtTime(p.createdAt)}</div></div>
            ${p.open ? `<span class="chip chip-ok">Open</span>` : `<span class="chip">Closed</span>`}</div>
          ${rewardGrid(p)}
          <div class="kv" style="margin-top:12px"><span>Escrow locked</span><strong>${UI.esc(fmtEth(p.escrow))}</strong></div>
          <div class="kv"><span>Paid out</span><span>${UI.esc(fmtEth(p.paid))}</span></div>
          <div class="kv"><span>Open reports</span><span>${p.openReports} of ${p.reportCount}</span></div>
          <div class="kv"><span>Response window</span><span>${fmtWindow(p.responseWindow)}</span></div>
          ${appeals ? `<div class="kv"><span>Appeals open until</span><span>${UI.fmtTime(p.appealsOpenUntil)}</span></div>` : ""}
          <div class="kv"><span>Public key</span><code title="${UI.esc(fps[i])}">${UI.esc(UI.short(fps[i], 6))}</code></div>
          <div class="kv"><span>Private key</span>${hasKey ? `<span class="chip chip-ok">In this browser's vault</span>` : `<span class="chip chip-warn">Not in this browser</span>`}</div>
          ${
            p.open
              ? `<div class="inline-form" style="margin-top:12px"><input type="number" min="0.01" step="0.01" value="2" data-topup-amt="${p.id}" aria-label="Top-up amount in ETH">
                 <button class="btn btn-secondary" data-topup="${p.id}">${Shell.icon("coins")} Top up escrow</button>
                 <button class="btn btn-danger" data-close="${p.id}">Close &amp; withdraw</button></div>`
              : ""
          }
          <div class="row" style="margin-top:10px">
            ${hasKey ? `<button class="btn btn-ghost btn-sm" data-dlkey="${p.id}">${Shell.icon("key")} Back up private key (.pem)</button>` : `<label class="btn btn-secondary btn-sm">Import private key (.pem)<input type="file" accept=".pem,.txt" data-keyimport="${p.id}" hidden></label>`}
            <button class="btn btn-ghost btn-sm" data-dlpub="${p.id}">Public key (.pem)</button>
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function bindPrograms(el, me, mine, action) {
    const byId = (id) => mine.find((p) => p.id === Number(id));
    el.querySelectorAll("[data-topup]").forEach((b) =>
      b.addEventListener("click", () => {
        const amt = el.querySelector(`[data-topup-amt="${b.dataset.topup}"]`).value;
        action(b, async () => {
          await Chain.send(me.address, "topUp", [Number(b.dataset.topup), { value: ethers.parseEther(String(amt)) }]);
          UI.toast(`${amt} ETH added to the escrow`, "success");
        });
      })
    );
    el.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () =>
        action(b, async () => {
          const { events } = await Chain.send(me.address, "closeProgram", [Number(b.dataset.close)]);
          UI.toast(`Program closed. ${fmtEth(events.find((e) => e.name === "ProgramClosed").args.refund)} returned to the company.`, "success");
        })
      )
    );
    el.querySelectorAll("[data-dlkey]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = byId(b.dataset.dlkey);
        UI.download(`${slug(p.name)}-private-key.pem`, BountyCrypto.toPem(vaultOf(me.address)[p.id], "PRIVATE KEY"));
      })
    );
    el.querySelectorAll("[data-dlpub]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = byId(b.dataset.dlpub);
        UI.download(`${slug(p.name)}-public-key.pem`, BountyCrypto.toPem(p.publicKey, "PUBLIC KEY"));
      })
    );
    el.querySelectorAll("[data-keyimport]").forEach((inp) =>
      inp.addEventListener("change", async () => {
        const p = byId(inp.dataset.keyimport);
        try {
          const { b64 } = BountyCrypto.fromPem(await UI.readFileText(inp.files[0]));
          if ((await BountyCrypto.publicFromPrivate(b64)) !== p.publicKey) throw new Error("This private key does not belong to the program's on-chain public key.");
          putKey(me.address, p.id, b64);
          UI.toast("Private key restored and checked against the on-chain public key", "success");
          Shell.render();
        } catch (e) {
          UI.toast(e.message, "error", 6000);
        }
      })
    );
  }

  function companyNew(me, state, prefill) {
    const s = prefill ? SAMPLE_PROGRAMS[me.name] || DEFAULT_PROGRAM : null;
    const d = s || DEFAULT_PROGRAM;
    const res = state.createResult && sameAddr(state.createResult.company, me.address) ? state.createResult : null;
    return `<div class="grid-2" style="align-items:start">
      <form class="card" id="create-form" autocomplete="off">
        <div class="card-head"><h2>Open a bounty program</h2><button type="button" class="btn btn-ghost btn-sm" id="load-sample-program">Load sample</button></div>
        <div class="field"><label for="f-name">Program name</label><input id="f-name" name="pname" type="text" required maxlength="80" value="${s ? UI.esc(s.name) : ""}" placeholder="${UI.esc(d.name)}"></div>
        <div class="field"><label for="f-scope">Scope (in scope / out of scope)</label><textarea id="f-scope" name="scope" rows="3" style="min-height:84px" placeholder="app.example.com">${s ? UI.esc(s.scope) : ""}</textarea></div>
        <div class="field"><label>Rewards per severity (ETH)</label>
          <div class="grid-4 reward-inputs">${SEV.map(
            (n, i) => `<div><span class="hint">${n}</span><input type="number" name="r${i}" min="0" step="0.01" required value="${UI.esc(d.rewards[i])}" aria-label="${n} reward in ETH"></div>`
          ).join("")}</div></div>
        <div class="grid-2" style="gap:12px">
          <div class="field"><label for="f-escrow">Escrow deposit (ETH)</label><input id="f-escrow" name="escrow" type="number" min="0" step="0.01" required value="${UI.esc(d.escrow)}">
            <span class="hint">Must cover at least the Critical reward.</span></div>
          <div class="field"><label for="f-window">Response window</label><select id="f-window" name="days">
            ${[1, 3, 7, 14].map((n) => `<option value="${n}" ${n === d.days ? "selected" : ""}>${n} day${n > 1 ? "s" : ""}</option>`).join("")}</select>
            <span class="hint">After this a researcher may escalate.</span></div>
        </div>
        <button class="btn" type="submit" id="create-btn" ${me.active ? "" : "disabled"}>${Shell.icon("key")} Generate key &amp; lock escrow</button>
        ${me.active ? "" : `<p class="small muted" style="margin-top:8px">This company is suspended by the Disclosure Council.</p>`}
      </form>
      <div class="card">
        <div class="card-head"><h2>What happens</h2></div>
        <div id="create-steps">${
          res
            ? UI.checklist(res.items)
            : `<p class="muted">The steps run in your browser: an RSA-OAEP key pair is generated, the public key and rewards are published on the blockchain together with the escrow deposit, and the private key goes into the company's off-chain vault.</p>`
        }</div>
      </div>
    </div>`;
  }

  function bindNew(el, me, state, action) {
    const form = el.querySelector("#create-form");
    el.querySelector("#load-sample-program").addEventListener("click", () => {
      const s = SAMPLE_PROGRAMS[me.name] || DEFAULT_PROGRAM;
      form.pname.value = s.name;
      form.scope.value = s.scope;
      s.rewards.forEach((v, i) => (form[`r${i}`].value = v));
      form.escrow.value = s.escrow;
      form.days.value = String(s.days);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = {
        name: form.pname.value.trim(),
        scope: form.scope.value.replace(/\r\n/g, "\n").trim(),
        rewards: [0, 1, 2, 3].map((i) => form[`r${i}`].value.trim()),
        escrow: form.escrow.value.trim(),
        days: Number(form.days.value),
      };
      if (!f.name) return UI.toast("Give the program a name", "error");
      action(el.querySelector("#create-btn"), async () => {
        await createProgram(me.address, f);
        state.companyTab = "new";
      });
    });
  }

  function researcherSlots(data) {
    const A = data.accounts;
    const list = RESEARCHER_SLOTS.filter((i) => A[i]).map((i) => A[i]);
    for (const r of data.researchers) if (!list.some((a) => sameAddr(a, r.address))) list.push(r.address);
    return list;
  }

  async function viewResearcher(el, { data, state, action }) {
    const slots = researcherSlots(data);
    if (!slots.some((a) => sameAddr(a, state.researcher))) state.researcher = slots[0];
    const addr = state.researcher;
    const idx = data.accounts.findIndex((a) => sameAddr(a, addr));
    const me = data.researchers.find((r) => sameAddr(r.address, addr));
    const myReports = data.reports.filter((r) => sameAddr(r.researcher, addr)).reverse();
    const openPrograms = data.programs.filter((p) => p.open);
    const res = state.submitResult && sameAddr(state.submitResult.researcher, addr) ? state.submitResult : null;
    const selProgram = openPrograms.some((p) => p.id === state.submitProgram) ? state.submitProgram : openPrograms[0]?.id;
    const draft = state.draft && sameAddr(state.draft.researcher, addr) ? state.draft : null;
    let tab = state.researcherTab || (myReports.length ? "reports" : "submit");
    if (!["submit", "reports"].includes(tab)) tab = "submit";

    const tabs = `<div class="segmented" style="margin-bottom:12px" role="tablist" aria-label="Researcher">${slots
      .map((a) => {
        const r = data.researchers.find((x) => sameAddr(x.address, a));
        const i = data.accounts.findIndex((x) => sameAddr(x, a));
        return `<button type="button" role="tab" data-researcher="${a}" class="${sameAddr(a, addr) ? "active" : ""}">${UI.esc(r ? r.handle : `Account #${i} (new)`)}</button>`;
      })
      .join("")}</div>`;

    const info = `<div class="card" style="margin-bottom:16px">
      <div class="card-head" style="margin-bottom:8px"><h2>${UI.esc(me ? me.handle : `Account #${idx}`)}</h2>${
        me ? `<span class="chip chip-ok">Registered researcher</span>` : `<span class="chip chip-warn">Not registered yet</span>`
      }</div>
      ${miniStats([
        ["Account", `<code>${UI.esc(UI.short(addr, 4))}</code>`],
        ["Wallet balance", UI.esc(fmtEth(data.balances[lower(addr)] || 0n))],
        ["Bounties earned", `<span class="money-up">${UI.esc(fmtEth(me ? me.earned : 0n))}</span>`],
        ["Reports", `${me ? me.submitted : 0} submitted · ${me ? me.accepted : 0} paid`],
      ])}
    </div>`;

    let main = "";
    if (!me) {
      main = `<div class="grid-2" style="align-items:start;margin-bottom:16px">
        <form class="card" id="reg-form" autocomplete="off">
          <div class="card-head"><h2>Register a researcher handle</h2></div>
          <p class="muted small">Joining is <strong>permissionless</strong>: any account can register once with a unique handle. No company or council approval is needed.</p>
          <div class="field"><label for="reg-handle">Handle (3-32 characters)</label><input id="reg-handle" type="text" maxlength="32" required value="${UI.esc(SUGGESTED_HANDLE[idx] || "")}"></div>
          <button class="btn" type="submit" id="register-btn">${Shell.icon("users")} Register on-chain</button>
        </form>
        <div class="card callout"><h2>Why register?</h2><p style="margin-top:8px">Your handle is how companies, the arbiter and the leaderboard see you. Every report you commit is linked to your account and timestamped, which is your proof of priority.</p></div>
      </div>`;
    } else if (tab === "submit") {
      const f = draft || {};
      main = `<div class="grid-2" style="align-items:start;margin-bottom:16px">
        <form class="card" id="submit-form" autocomplete="off">
          <div class="card-head"><h2>Submit an encrypted report</h2></div>
          ${
            openPrograms.length
              ? `<div class="row sample-row"><span class="small muted">Load a sample:</span>${SAMPLE_REPORTS.map(
                  (s) => `<button type="button" class="btn btn-ghost btn-sm" data-sample="${s.key}">${UI.esc(s.label)}</button>`
                ).join("")}</div>
          <div class="field"><label for="f-program">Bounty program</label><select id="f-program" name="program">${openPrograms
            .map((p) => `<option value="${p.id}" ${p.id === selProgram ? "selected" : ""}>${UI.esc(p.name)} · ${UI.esc(Chain.label(p.company))} (up to ${UI.esc(fmtEth(p.rewards[3]))})</option>`)
            .join("")}</select></div>
          <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" type="text" required maxlength="140" value="${UI.esc(f.title || "")}" placeholder="IDOR on /api/accounts/{id}"></div>
          <div class="grid-2" style="gap:12px">
            <div class="field"><label for="f-asset">Affected asset</label><input id="f-asset" name="asset" type="text" required value="${UI.esc(f.asset || "")}" placeholder="https://api.example/v2/…"></div>
            <div class="field"><label for="f-sev">Claimed severity</label><select id="f-sev" name="severity">${SEV.map(
              (s, i) => `<option value="${i}" ${Number(f.severity ?? 2) === i ? "selected" : ""}>${s}</option>`
            ).join("")}</select></div>
          </div>
          <div class="field"><label for="f-steps">Steps to reproduce</label><textarea id="f-steps" name="steps" rows="5" required>${UI.esc(f.steps || "")}</textarea></div>
          <div class="field"><label for="f-impact">Impact</label><textarea id="f-impact" name="impact" rows="2" style="min-height:70px" required>${UI.esc(f.impact || "")}</textarea></div>
          <button class="btn" type="submit" id="submit-btn">${Shell.icon("shield")} Encrypt &amp; submit</button>`
              : `<div class="empty">No open bounty programs yet. A company must create one first.</div>`
          }
        </form>
        <div class="card">
          <div class="card-head"><h2>What happens</h2></div>
          <div id="submit-steps">${
            res
              ? UI.checklist(res.items)
              : `<p class="muted">Your report is encrypted in this browser for the company's public key. Only two hashes and the time go on the blockchain, so nobody else learns the bug, but everyone can later verify that you reported it first.</p>`
          }</div>
          ${res && res.items.every((i) => i.status === "ok") ? `<button type="button" class="btn btn-secondary btn-sm" data-rtab="reports" style="margin-top:14px">See it in My reports</button>` : ""}
        </div>
      </div>`;
    }

    const reportsHtml = myReports.length
      ? myReports
          .map((r) => {
            const st = reportState(r);
            const title = titleOf(r);
            const early = isAwaitingCompany(r) && Chain.now() < r.deadline;
            const showEscalate = r.dispute === DISPUTE.None && (r.status === STATUS.Pending || canEscalate(r));
            return `<div class="card">
              <div class="card-head" style="margin-bottom:6px"><div><h3>#${r.id} · ${UI.esc(title || "Encrypted report")}</h3>
                <div class="muted small">${UI.esc(r.program.name)} · ${UI.esc(Chain.label(r.program.company))} · claimed ${SEV[r.claimed]}</div></div>
                <span class="chip ${st.chip}">${UI.esc(st.label)}</span></div>
              ${timeline(r)}
              <div class="kv" style="margin-top:10px"><span>reportHash</span><code title="${r.reportHash}">${UI.short(r.reportHash, 8)}</code></div>
              <div class="row" style="margin-top:8px">
                ${
                  showEscalate
                    ? `<button class="btn ${canEscalate(r) ? "" : "btn-secondary"} btn-sm" data-escalate="${r.id}">${Shell.icon("forward")} ${
                        r.status === STATUS.Pending ? "Escalate to arbiter" : "Appeal to arbiter"
                      }</button>`
                    : ""
                }
                ${early ? `<button class="btn btn-ghost btn-sm" data-jump="${r.id}">Jump past deadline</button><span class="muted small">Escalation opens ${UI.fmtTime(r.deadline)}</span>` : ""}
                ${copies()[r.reportHash] ? `<button class="btn btn-ghost btn-sm" data-dlcopy="${r.id}">My report (.json)</button>` : ""}
              </div>
            </div>`;
          })
          .join("")
      : `<div class="card empty">No reports yet.</div>`;

    const subTabs = me
      ? `<div class="segmented" style="margin-bottom:16px" role="tablist" aria-label="Researcher sections">
          <button type="button" role="tab" data-rtab="submit" class="${tab === "submit" ? "active" : ""}">Submit a report</button>
          <button type="button" role="tab" data-rtab="reports" class="${tab === "reports" ? "active" : ""}">My reports (${myReports.length})</button>
        </div>`
      : "";
    const reportsSection =
      me && tab === "reports"
        ? `<p class="muted small" style="margin:0 0 10px">Status timeline read from the smart contract. Escalation opens when the company rejects a report, marks it duplicate, or misses its deadline.</p>
           <div class="stack" id="my-reports">${reportsHtml}</div>`
        : "";

    el.innerHTML = `
      ${pageHead(
        "Researcher",
        "Find a bug, encrypt the report for the company and commit its hash on-chain. You get a timestamped proof of priority, automatic payment when the company accepts, and a neutral arbiter if it does not."
      )}
      ${tabs}${info}${subTabs}${main}${reportsSection}`;

    el.querySelectorAll("[data-researcher]").forEach((b) =>
      b.addEventListener("click", () => {
        state.researcher = b.dataset.researcher;
        state.researcherTab = null;
        Shell.render();
      })
    );
    el.querySelectorAll("[data-rtab]").forEach((b) =>
      b.addEventListener("click", () => {
        state.researcherTab = b.dataset.rtab;
        Shell.render();
      })
    );
    const reg = el.querySelector("#reg-form");
    if (reg)
      reg.addEventListener("submit", (e) => {
        e.preventDefault();
        const handle = el.querySelector("#reg-handle").value.trim();
        action(el.querySelector("#register-btn"), async () => {
          await Chain.send(addr, "registerResearcher", [handle]);
          UI.toast(`Welcome, ${handle}! You can now submit reports.`, "success");
        });
      });
    const form = el.querySelector("#submit-form");
    if (form && el.querySelector("#f-title")) {
      const saveDraft = () =>
        (state.draft = {
          researcher: addr,
          title: form.title.value,
          asset: form.asset.value,
          severity: Number(form.severity.value),
          steps: form.steps.value,
          impact: form.impact.value,
        });
      form.addEventListener("input", saveDraft);
      form.program.addEventListener("change", () => (state.submitProgram = Number(form.program.value)));
      el.querySelectorAll("[data-sample]").forEach((b) =>
        b.addEventListener("click", () => {
          const s = SAMPLE_REPORTS.find((x) => x.key === b.dataset.sample);
          form.title.value = s.title;
          form.asset.value = s.asset;
          form.severity.value = String(s.severity);
          form.steps.value = s.steps;
          form.impact.value = s.impact;
          saveDraft();
        })
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const f = {
          programId: Number(form.program.value),
          title: form.title.value.trim(),
          asset: form.asset.value.trim(),
          severity: Number(form.severity.value),
          steps: form.steps.value.replace(/\r\n/g, "\n").trim(),
          impact: form.impact.value.replace(/\r\n/g, "\n").trim(),
        };
        if (!f.title || !f.asset || !f.steps || !f.impact) return UI.toast("Fill in title, asset, steps and impact", "error");
        state.submitProgram = f.programId;
        state.researcherTab = "submit"; // keep the steps in view after the re-render
        action(el.querySelector("#submit-btn"), async () => {
          await submitReport(addr, f);
          state.draft = null;
        });
      });
    }
    el.querySelectorAll("[data-escalate]").forEach((b) => b.addEventListener("click", () => action(b, () => escalate(addr, Number(b.dataset.escalate)))));
    el.querySelectorAll("[data-jump]").forEach((b) =>
      b.addEventListener("click", () =>
        action(b, async () => {
          const r = data.reports[Number(b.dataset.jump)];
          await Chain.fastForward(r.deadline - Chain.now() + 5);
          UI.toast(`Blockchain time moved past the response deadline of report #${r.id}`, "success");
        })
      )
    );
    el.querySelectorAll("[data-dlcopy]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = data.reports[Number(b.dataset.dlcopy)];
        UI.download(`report-${r.id}.json`, copies()[r.reportHash], "application/json");
      })
    );
  }

  async function viewCouncil(el, { data, state, action }) {
    const disputes = data.reports.filter((r) => r.dispute === DISPUTE.Open);
    const resolved = data.reports.filter((r) => r.dispute === DISPUTE.ResearcherWon || r.dispute === DISPUTE.CompanyWon);
    const verified = state.verified && disputes.some((r) => r.id === state.verified.reportId) ? state.verified : null;
    const taken = new Set([...data.companies.map((c) => lower(c.address)), ...data.researchers.map((r) => lower(r.address)), lower(council())]);
    const free = data.accounts.map((a, i) => ({ a, i })).filter(({ a }) => !taken.has(lower(a)));
    const suggest = free.some(({ i }) => i === NEW_COMPANY.account) && !data.companies.some((c) => c.name === NEW_COMPANY.name);

    const decision = (r) => {
      if (r.status === STATUS.Rejected) return `Rejected at ${UI.fmtTime(r.respondedAt)}: "${UI.esc(r.reason)}"`;
      if (r.status === STATUS.Duplicate) {
        const o = data.reports[r.duplicateOf];
        return `Marked duplicate of #${o.id} (by ${UI.esc(Chain.label(o.researcher))}, ${UI.fmtTime(o.submittedAt)})`;
      }
      return `<span class="chip chip-bad">No response</span> deadline was ${UI.fmtTime(r.deadline)}`;
    };

    const queue = disputes.length
      ? disputes
          .map((r) => {
            const v = verified && verified.reportId === r.id ? verified : null;
            const p = r.program;
            return `<div class="dispute">
              <div class="card-head" style="margin-bottom:8px"><div><h3>Report #${r.id} · ${UI.esc(p.name)}</h3><div class="muted small">${UI.esc(Chain.label(r.researcher))} vs ${UI.esc(Chain.label(p.company))}</div></div><span class="chip chip-warn">Escalated</span></div>
              <div class="kv"><span>Claimed</span>${sevChip(r.claimed)}</div>
              <div class="kv"><span>Committed</span><span>${UI.fmtTime(r.submittedAt)}</span></div>
              <div class="kv"><span>Company</span><span>${decision(r)}</span></div>
              <div class="kv"><span>Escalated</span><span>${UI.fmtTime(r.escalatedAt)}</span></div>
              <div class="kv"><span>Escrow left</span><span>${UI.esc(fmtEth(p.escrow))}</span></div>
              <div class="row" style="margin-top:8px">
                <button class="btn btn-sm ${v ? "btn-secondary" : ""}" data-verify="${r.id}">${Shell.icon("check")} Verify revealed report</button>
                ${evidence()[r.id] ? "" : `<label class="btn btn-secondary btn-sm">Import revealed report<input type="file" accept=".json,application/json" data-evimport="${r.id}" hidden></label>`}
              </div>
              <div class="verify-host" data-host="${r.id}">${
                v
                  ? `<div id="verify-steps" style="margin-top:12px">${UI.checklist(v.items)}</div>${
                      v.report
                        ? `${reportView(v.report)}
                  <div class="triage">
                    <div class="label">Decision</div>
                    <div class="inline-form"><select data-sev-for="${r.id}" aria-label="Severity to award">${SEV.map(
                      (s, i) => `<option value="${i}" ${i === r.claimed ? "selected" : ""}>${s} · ${UI.esc(fmtEth(p.rewards[i]))}</option>`
                    ).join("")}</select>
                    <button class="btn" data-award="${r.id}">${Shell.icon("coins")} Rule for researcher &amp; pay</button>
                    <button class="btn btn-secondary" data-dismiss="${r.id}">Dismiss (rule for company)</button></div>
                  </div>`
                        : ""
                    }`
                  : ""
              }</div>
            </div>`;
          })
          .join("")
      : `<div class="empty">No open disputes. Escalated reports appear here.</div>`;

    el.innerHTML = `
      ${pageHead(
        "Disclosure Council",
        `Account 0 (<code>${UI.esc(UI.short(council(), 4))}</code>) runs the consortium: it admits companies (permissioned) and acts as the neutral arbiter when a researcher escalates. It can force payout from a program's escrow.`
      )}
      <div class="grid-2" style="align-items:start">
        <div class="stack">
          <div class="card"><div class="card-head"><h2>Disputes queue</h2><span class="muted small">${disputes.length} open</span></div><div class="stack">${queue}</div></div>
          <div class="card"><div class="card-head"><h2>Resolved disputes</h2></div>${
            resolved.length
              ? `<div class="table-wrap"><table class="table"><thead><tr><th>Report</th><th>Researcher</th><th>Ruling</th><th>Paid</th></tr></thead><tbody>${resolved
                  .map(
                    (r) => `<tr><td data-label="Report">#${r.id} · ${UI.esc(r.program.name)}</td><td data-label="Researcher">${UI.esc(Chain.label(r.researcher))}</td>
                    <td data-label="Ruling">${r.dispute === DISPUTE.ResearcherWon ? `<span class="chip chip-ok">For researcher (${SEV[r.awarded]})</span>` : `<span class="chip">Dismissed</span>`}</td>
                    <td data-label="Paid">${UI.esc(fmtEth(r.dispute === DISPUTE.ResearcherWon ? r.payout : 0n))}</td></tr>`
                  )
                  .join("")}</tbody></table></div>`
              : `<p class="muted">None yet.</p>`
          }</div>
        </div>
        <div class="stack">
          <form class="card" id="company-form" autocomplete="off">
            <div class="card-head"><h2>Admit a company</h2><span class="muted small">Permissioned: only the Council</span></div>
            ${
              free.length
                ? `<div class="field"><label for="nc-account">Account</label><select id="nc-account">${free
                    .map(({ a, i }) => `<option value="${a}" ${i === NEW_COMPANY.account ? "selected" : ""}>Account #${i} · ${UI.esc(UI.short(a, 4))}</option>`)
                    .join("")}</select></div>
              <div class="field"><label for="nc-name">Organisation name</label><input id="nc-name" type="text" required maxlength="60" value="${suggest ? UI.esc(NEW_COMPANY.name) : ""}" placeholder="Organisation name"></div>
              <button class="btn" type="submit" id="nc-btn">${Shell.icon("building")} Register company</button>`
                : `<p class="muted">All demo accounts are already registered.</p>`
            }
          </form>
          <div class="card">
            <div class="card-head"><h2>Consortium</h2></div>
            <div class="table-wrap"><table class="table"><thead><tr><th>Member</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>
              <tr><td data-label="Member"><strong>Disclosure Council</strong><div class="muted small"><code>${UI.esc(UI.short(council(), 4))}</code></div></td><td data-label="Type"><span class="chip chip-accent">Admin + arbiter</span></td><td data-label="Status"><span class="chip chip-ok">Active</span></td><td class="hide-mobile"></td></tr>
              ${data.companies
                .map(
                  (c) => `<tr><td data-label="Member"><strong>${UI.esc(c.name)}</strong><div class="muted small"><code>${UI.esc(UI.short(c.address, 4))}</code></div></td>
                  <td data-label="Type"><span class="chip">Company</span></td>
                  <td data-label="Status">${c.active ? `<span class="chip chip-ok">Active</span>` : `<span class="chip chip-bad">Suspended</span>`}</td>
                  <td data-label="Action"><button class="btn btn-secondary btn-sm" data-toggle="${c.address}" data-active="${c.active}">${c.active ? "Suspend" : "Activate"}</button></td></tr>`
                )
                .join("")}
              ${data.researchers
                .map(
                  (r) => `<tr><td data-label="Member"><strong>${UI.esc(r.handle)}</strong><div class="muted small"><code>${UI.esc(UI.short(r.address, 4))}</code></div></td>
                  <td data-label="Type"><span class="chip">Researcher</span></td><td data-label="Status"><span class="chip chip-ok">Self-registered</span></td><td class="hide-mobile"></td></tr>`
                )
                .join("")}
            </tbody></table></div>
          </div>
        </div>
      </div>`;

    el.querySelectorAll("[data-verify]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = data.reports[Number(b.dataset.verify)];
        el.querySelectorAll("#verify-steps").forEach((x) => x.removeAttribute("id"));
        el.querySelector(`[data-host="${r.id}"]`).innerHTML = `<div id="verify-steps" style="margin-top:12px"></div>`;
        action(b, () => verifyEvidence(r, data));
      })
    );
    el.querySelectorAll("[data-evimport]").forEach((inp) =>
      inp.addEventListener("change", async () => {
        const r = data.reports[Number(inp.dataset.evimport)];
        const text = await UI.readFileText(inp.files[0]);
        if ((await UI.sha256(text)) !== r.reportHash) return UI.toast("This file does not match the reportHash committed on-chain", "error", 6000);
        putIn("evidence", r.id, text);
        UI.toast("Revealed report imported and verified", "success");
        Shell.render();
      })
    );
    el.querySelectorAll("[data-award]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = Number(b.dataset.award);
        const sev = Number(el.querySelector(`[data-sev-for="${id}"]`).value);
        action(b, () => resolveDispute(id, true, sev));
      })
    );
    el.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => action(b, () => resolveDispute(Number(b.dataset.dismiss), false, 0))));
    const cf = el.querySelector("#company-form");
    if (cf && el.querySelector("#nc-btn"))
      cf.addEventListener("submit", (e) => {
        e.preventDefault();
        const account = el.querySelector("#nc-account").value;
        const name = el.querySelector("#nc-name").value.trim();
        action(el.querySelector("#nc-btn"), async () => {
          await Chain.send(council(), "registerCompany", [account, name]);
          UI.toast(`${name} admitted to the consortium`, "success");
        });
      });
    el.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => action(b, () => Chain.send(council(), "setCompanyActive", [b.dataset.toggle, b.dataset.active !== "true"])))
    );
  }

  async function viewLeaderboard(el, { data }) {
    const ranked = [...data.researchers].sort((a, b) => (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : b.accepted - a.accepted));
    const now = Chain.now();
    const record = data.companies.map((c) => {
      const rs = data.reports.filter((r) => sameAddr(r.program.company, c.address));
      return {
        c,
        programs: data.programs.filter((p) => sameAddr(p.company, c.address)).length,
        received: rs.length,
        accepted: rs.filter((r) => r.status === STATUS.Accepted).length,
        refused: rs.filter((r) => r.status === STATUS.Rejected || r.status === STATUS.Duplicate).length,
        ignored: rs.filter((r) => r.status === STATUS.Pending && now >= r.deadline).length,
        lost: rs.filter((r) => r.dispute === DISPUTE.ResearcherWon).length,
        paid: data.programs.filter((p) => sameAddr(p.company, c.address)).reduce((s, p) => s + p.paid, 0n),
      };
    });

    el.innerHTML = `
      ${pageHead("Leaderboard", "Hall of fame of researchers, ranked by bounties earned, and each company's public track record. Every number is read from the smart contract.")}
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Hall of fame</h2><span class="muted small">Paid by companies or forced by the arbiter</span></div>
          ${
            ranked.length
              ? `<div class="table-wrap"><table class="table" id="hall"><thead><tr><th>Rank</th><th>Researcher</th><th>Earned</th><th>Paid reports</th><th>Submitted</th><th>Wallet</th></tr></thead><tbody>${ranked
                  .map(
                    (r, i) => `<tr><td data-label="Rank"><span class="rank rank-${i + 1}">${i + 1}</span></td>
                    <td data-label="Researcher"><strong>${UI.esc(r.handle)}</strong><div class="muted small"><code>${UI.esc(UI.short(r.address, 4))}</code></div></td>
                    <td data-label="Earned"><span class="money ${r.earned > 0n ? "money-up" : ""}">${UI.esc(fmtEth(r.earned))}</span></td>
                    <td data-label="Paid reports">${r.accepted}</td><td data-label="Submitted">${r.submitted}</td>
                    <td data-label="Wallet">${UI.esc(fmtEth(data.balances[lower(r.address)] || 0n, 2))}</td></tr>`
                  )
                  .join("")}</tbody></table></div>`
              : `<div class="empty">No researchers yet.</div>`
          }
        </div>
        <div class="card">
          <div class="card-head"><h2>Company track record</h2><span class="muted small">Ignoring reports is visible to everyone</span></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Company</th><th>Programs</th><th>Reports</th><th>Accepted</th><th>Rejected / duplicate</th><th>Ignored past deadline</th><th>Disputes lost</th><th>Paid out</th></tr></thead><tbody>${record
            .map(
              (x) => `<tr><td data-label="Company"><strong>${UI.esc(x.c.name)}</strong></td><td data-label="Programs">${x.programs}</td><td data-label="Reports">${x.received}</td>
              <td data-label="Accepted">${x.accepted}</td><td data-label="Rejected/dup.">${x.refused}</td>
              <td data-label="Ignored">${x.ignored ? `<span class="chip chip-bad">${x.ignored}</span>` : "0"}</td>
              <td data-label="Disputes lost">${x.lost}</td><td data-label="Paid out">${UI.esc(fmtEth(x.paid))}</td></tr>`
            )
            .join("")}</tbody></table></div>
        </div>
      </div>`;
  }

  async function viewPriority(el, { data, state, action }) {
    const pr = state.priority;
    const options = [];
    for (const r of data.reports) {
      if (copies()[r.reportHash] || evidence()[r.id]) options.push(`<option value="plain:${r.id}">Report #${r.id} · plaintext (${UI.esc(Chain.label(r.researcher))})</option>`);
      if (server()[r.cipherHash]) options.push(`<option value="pkg:${r.id}">Report #${r.id} · encrypted package</option>`);
    }
    let result = `<p class="muted">Paste a disclosed report (.json) or an encrypted package. Its SHA-256 is looked up on the blockchain to show who committed it, and when.</p>`;
    if (pr) {
      const r = pr.ok ? data.reports[pr.reportId] : null;
      result = `<div id="priority-steps">${UI.checklist(pr.items)}</div>${
        r
          ? `<div class="callout callout-ok" style="margin-top:12px"><div class="small muted">Proof of priority</div>
               <div style="font-size:1.1rem;font-weight:700">${UI.esc(Chain.label(r.researcher))} had this exact report at ${UI.fmtTime(r.submittedAt)}</div>
               <div class="small">Report #${r.id} · ${UI.esc(r.program.name)} · status: ${UI.esc(reportState(r).label)}</div></div>`
          : `<div class="callout callout-bad" style="margin-top:12px"><strong>No match.</strong> Changing even one character changes the SHA-256 hash completely, so an edited report cannot borrow someone else's timestamp.</div>`
      }`;
    }
    el.innerHTML = `
      ${pageHead(
        "Proof of Priority",
        "Who found it first? A report's SHA-256 hash was committed on-chain with a block timestamp. Anyone holding the report can check it here, without trusting the company or the researcher."
      )}
      <div class="grid-2" style="align-items:start">
        <form class="card" id="priority-form">
          <div class="card-head"><h2>Report or package</h2>
            ${options.length ? `<div class="inline-form"><select id="copy-select" aria-label="Load a stored report">${options.join("")}</select><button type="button" class="btn btn-secondary btn-sm" id="load-copy">Load</button></div>` : ""}</div>
          <div class="field"><textarea id="priority-text" rows="12" placeholder='{"format":"bountychain-plaintext/1", …}'>${UI.esc(state.priorityText || "")}</textarea></div>
          <div class="row"><button class="btn" type="submit" id="check-btn">${Shell.icon("search")} Check on blockchain</button>
            <button type="button" class="btn btn-secondary" id="tamper-btn">Change one character &amp; re-check</button>
            <label class="btn btn-ghost">Upload file<input type="file" accept=".json,.txt,application/json" id="priority-file" hidden></label></div>
        </form>
        <div class="card"><div class="card-head"><h2>Result</h2></div>${result}</div>
      </div>`;

    const form = el.querySelector("#priority-form");
    const ta = el.querySelector("#priority-text");
    const check = (btn) => {
      state.priorityText = ta.value;
      action(btn, () => checkPriority(ta.value, data));
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      check(el.querySelector("#check-btn"));
    });
    el.querySelector("#tamper-btn").addEventListener("click", (e) => {
      const t = ta.value;
      if (!t) return UI.toast("Load a report first", "error");
      const i = Math.max(t.indexOf('"title":"') + 9, 0);
      const ch = t[i] === "X" ? "Y" : "X";
      ta.value = t.slice(0, i) + ch + t.slice(i + 1);
      check(e.currentTarget);
    });
    const lc = el.querySelector("#load-copy");
    if (lc)
      lc.addEventListener("click", () => {
        const [kind, id] = el.querySelector("#copy-select").value.split(":");
        const r = data.reports[Number(id)];
        ta.value = kind === "pkg" ? server()[r.cipherHash] : copies()[r.reportHash] || evidence()[r.id];
        state.priorityText = ta.value;
      });
    el.querySelector("#priority-file").addEventListener("change", async (e) => {
      ta.value = (await UI.readFileText(e.target.files[0])).trim();
      state.priorityText = ta.value;
    });
  }

  function formatEvent(e) {
    const a = e.args;
    switch (e.name) {
      case "CompanyRegistered":
        return `${a.name} admitted as a company by the Disclosure Council`;
      case "CompanyStatusChanged":
        return `${Chain.label(a.account)} ${a.active ? "re-activated" : "suspended"} by the Council`;
      case "ResearcherRegistered":
        return `${a.handle} registered as a researcher (permissionless)`;
      case "ProgramCreated":
        return `${Chain.label(a.company)} opened program #${a.programId} "${a.name}" with ${fmtEth(a.escrow)} in escrow · response window ${fmtWindow(a.responseWindow)}`;
      case "ProgramToppedUp":
        return `Program #${a.programId} topped up by ${fmtEth(a.amount)} (escrow now ${fmtEth(a.escrow)})`;
      case "ProgramClosed":
        return `Program #${a.programId} closed · ${fmtEth(a.refund)} returned to the company`;
      case "ReportSubmitted":
        return `${Chain.label(a.researcher)} committed report #${a.reportId} to program #${a.programId} (claimed ${SEV[Number(a.claimed)]}) · report hash ${UI.short(a.reportHash, 4)}`;
      case "ReportAccepted":
        return `Report #${a.reportId} accepted as ${SEV[Number(a.severity)]} · ${fmtEth(a.payout)} released from escrow`;
      case "ReportRejected":
        return `Report #${a.reportId} rejected: "${a.reason}" · appeal possible until ${UI.fmtTime(a.appealDeadline)}`;
      case "ReportMarkedDuplicate":
        return `Report #${a.reportId} marked as duplicate of earlier report #${a.originalReportId}`;
      case "ReportEscalated":
        return `${Chain.label(a.researcher)} escalated report #${a.reportId} to the arbiter (company decision: ${
          ["no response", "accepted", "rejected", "duplicate"][Number(a.companyDecision)]
        })`;
      case "DisputeResolved":
        return a.inFavourOfResearcher
          ? `Arbiter ruled for the researcher on report #${a.reportId} (${SEV[Number(a.severity)]}) · ${fmtEth(a.payout)} forced from escrow`
          : `Arbiter dismissed the dispute on report #${a.reportId}`;
      case "BountyPaid":
        return `${fmtEth(a.amount)} paid to ${Chain.label(a.researcher)} for report #${a.reportId}`;
      default:
        return "";
    }
  }

  async function viewExplorer(el) {
    el.innerHTML = `${pageHead(
      "Blockchain Explorer",
      "Every program, report commitment, decision and payout is a transaction in a block. Each block stores the hash of the previous one, so no record of who reported first can be changed later."
    )}<div id="explorer-host"></div>`;
    await Explorer.render(el.querySelector("#explorer-host"), { formatEvent });
  }

  async function viewAbout(el) {
    el.innerHTML = `
      ${pageHead("About the project", "BountyChain: a bug bounty and responsible disclosure platform using a smart-contract escrow, hybrid encryption and on-chain hash commitments.")}
      <div class="stack">
        <div class="card">
          <h2>Problem</h2>
          <p style="margin-top:8px">Security researchers who responsibly report vulnerabilities risk not being credited or paid. A company can silently ignore a report or claim "we already knew", and there is no neutral record of who found a bug first.</p>
          <h2 style="margin-top:14px">Solution</h2>
          <ul style="margin:8px 0 0;padding-left:18px">
            <li><strong>Money up front:</strong> the rewards are locked in the smart contract when a program opens. Accepting a report pays automatically.</li>
            <li><strong>Proof of priority:</strong> the researcher commits SHA-256 hashes of the report and of the encrypted package. The block timestamp proves who was first, without revealing the bug.</li>
            <li><strong>Confidentiality:</strong> reports are encrypted in the browser for the company's RSA public key (RSA-OAEP + AES-256-GCM). The ciphertext stays off-chain.</li>
            <li><strong>Accountability:</strong> the contract enforces a response deadline, a "duplicate" must point to an earlier on-chain report, a neutral arbiter can force payout, and the escrow cannot be withdrawn while reports or appeals are open.</li>
          </ul>
        </div>
        <div class="card">
          <h2>Syllabus mapping (22CS743)</h2>
          <div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Module</th><th>Concept</th><th>Where it is used</th></tr></thead><tbody>
            <tr><td data-label="Module">II</td><td data-label="Concept">Hash functions, hash commitments, timestamping, hash-linked blocks</td><td data-label="Used in">Salted SHA-256 <code>reportHash</code> and <code>cipherHash</code> committed with the block time as proof of priority; Proof of Priority page; explorer checks each block's previous-hash link</td></tr>
            <tr><td data-label="Module">III</td><td data-label="Concept">Ethereum, EVM, smart contracts, symmetric &amp; asymmetric cryptography</td><td data-label="Used in"><code>BugBounty.sol</code> escrow: <code>payable</code> deposit, automatic ETH transfer on accept or ruling; RSA-OAEP 2048 key wrapping + AES-256-GCM report encryption; signed transactions</td></tr>
            <tr><td data-label="Module">IV</td><td data-label="Concept">Consortium / permissioned blockchain, governance</td><td data-label="Used in">Companies are admitted (or suspended) by the Disclosure Council; researchers join without permission; the Council is the neutral arbiter</td></tr>
            <tr><td data-label="Module">V</td><td data-label="Concept">Cybersecurity application, smart-contract security, privacy</td><td data-label="Used in">Responsible disclosure workflow; checks-effects-interactions, re-entrancy lock, access control and custom errors (tested with an attack contract); only hashes on-chain</td></tr>
          </tbody></table></div>
        </div>
        <div class="grid-2">
          <div class="card">
            <h2>On-chain vs off-chain</h2>
            <p class="muted small" style="margin-top:6px">Everything on a blockchain is public, so vulnerability details never go on-chain.</p>
            <ul style="margin:6px 0 0;padding-left:18px">
              <li><strong>On-chain:</strong> companies, researcher handles, programs (scope, rewards, escrow, RSA public key, response window), report hashes, claimed and awarded severity, times, decisions, payouts, disputes.</li>
              <li><strong>Off-chain:</strong> encrypted report packages (report server), each program's RSA private key (company vault), researchers' plaintext copies, reports revealed to the arbiter.</li>
            </ul>
          </div>
          <div class="card">
            <h2>Smart-contract security</h2>
            <ul style="margin:6px 0 0;padding-left:18px">
              <li>Checks-effects-interactions: all bookkeeping is updated before any ETH is sent.</li>
              <li>A re-entrancy lock on every function that sends ETH; <code>call</code> result is checked (<code>TransferFailed</code>).</li>
              <li>Role checks: Council, program owner, report owner. Custom errors with clear reasons.</li>
              <li>Escrow cannot leave while reports wait for an answer or appeals are open.</li>
            </ul>
          </div>
        </div>
        <div class="card">
          <h2>Technology</h2>
          <ul style="margin:6px 0 0;padding-left:18px">
            <li>Solidity 0.8.24 smart contract, Hardhat (local blockchain + 24 tests)</li>
            <li>In-browser Ethereum chain (Ganache) for zero-install demos; test ETH only</li>
            <li>ethers.js v6, Web Crypto API (RSA-OAEP 2048, AES-256-GCM, SHA-256)</li>
            <li>HTML, CSS and JavaScript (no build step), hosted on GitHub Pages</li>
          </ul>
        </div>
        <div class="card callout-warn">
          <h2>Limitations</h2>
          <ul style="margin:6px 0 0;padding-left:18px">
            <li>Rejection reasons and severities are public. Companies should keep reasons short and generic.</li>
            <li>In a dispute the researcher reveals the report to the Council. A production system would encrypt it to the Council's key.</li>
            <li>The arbiter is one trusted account. A real platform could use a multi-signature council or a vote.</li>
            <li>Only identical reports are detected automatically; the same bug described in other words needs human triage (duplicate + arbiter).</li>
            <li>The demo keeps private keys in browser storage; real companies would use a hardware key store.</li>
          </ul>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  Shell.start({
    brand: { name: "BountyChain", tagline: "Bug bounty & responsible disclosure on blockchain", icon: "bug" },
    timeTravel: true,
    load,
    chain: {
      storageKey: "bountychain",
      artifact: window.CONTRACT_ARTIFACT,
      errors: ERRORS,
      async isSeeded(chain) {
        const [accts] = await chain.contract.getCompanies();
        return accts.length > 0;
      },
      async seed(chain) {
        const A = chain.accounts;
        for (const [i, name] of COMPANIES) await chain.send(A[0], "registerCompany", [A[i], name]);
        for (const [i, handle] of RESEARCHERS) await chain.send(A[i], "registerResearcher", [handle]);
      },
    },
    routes: [
      { id: "home", title: "Overview", icon: "home", render: viewHome },
      { id: "programs", title: "Bounty Programs", icon: "layers", section: "Public", render: viewPrograms },
      { id: "leaderboard", title: "Leaderboard", icon: "coins", section: "Public", render: viewLeaderboard },
      { id: "company", title: "Company", icon: "building", section: "Roles", render: viewCompany },
      { id: "researcher", title: "Researcher", icon: "bug", section: "Roles", render: viewResearcher },
      { id: "council", title: "Disclosure Council", icon: "shield", section: "Roles", render: viewCouncil },
      { id: "priority", title: "Proof of Priority", icon: "search", section: "Investigate", render: viewPriority },
      { id: "explorer", title: "Blockchain Explorer", icon: "blocks", section: "Investigate", render: viewExplorer },
      { id: "about", title: "About & Syllabus", icon: "book", section: "Project", render: viewAbout },
    ],
  });

  // Exposed for automated tests.
  window.BountyApp = {
    createProgram,
    submitReport,
    decryptReport,
    acceptReport,
    rejectReport,
    markDuplicate,
    escalate,
    verifyEvidence,
    resolveDispute,
    checkPriority,
    load,
    SAMPLE_REPORTS,
    SAMPLE_PROGRAMS,
  };
})();
