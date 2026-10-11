const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const Sev = { Low: 0, Medium: 1, High: 2, Critical: 3 };
const Status = { Pending: 0, Accepted: 1, Rejected: 2, Duplicate: 3 };
const Dispute = { None: 0, Open: 1, ResearcherWon: 2, CompanyWon: 3 };
const ETH = (v) => ethers.parseEther(String(v));
const sha = (text) => ethers.sha256(ethers.toUtf8Bytes(text));
const DAY = 24 * 3600;
const REWARDS = [ETH("0.5"), ETH(1), ETH("2.5"), ETH(5)];
const PUBKEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA-demo-key";

describe("BugBounty", function () {
  async function deployFixture() {
    const [council, bank, cloud, anaya, ravi, kim, outsider] = await ethers.getSigners();
    const bounty = await ethers.deployContract("BugBounty", [], council);

    await bounty.registerCompany(bank.address, "PaySecure Bank (demo)");
    await bounty.registerCompany(cloud.address, "CampusCloud");
    await bounty.connect(anaya).registerResearcher("0xAnaya");
    await bounty.connect(ravi).registerResearcher("nullbyte_ravi");

    await bounty.connect(bank).createProgram("PaySecure Online Banking", "*.paysecure.example", PUBKEY, REWARDS, 3 * DAY, {
      value: ETH(12),
    });
    return { bounty, council, bank, cloud, anaya, ravi, kim, outsider };
  }

  /** Program 0 with report 0 (anaya, High) and report 1 (ravi, Critical). */
  async function reportsFixture() {
    const f = await deployFixture();
    await f.bounty.connect(f.anaya).submitReport(0, sha("pkg-0"), sha("report-0"), Sev.High);
    await f.bounty.connect(f.ravi).submitReport(0, sha("pkg-1"), sha("report-1"), Sev.Critical);
    return f;
  }

  describe("Consortium membership", function () {
    it("only the Council can admit companies", async function () {
      const { bounty, outsider } = await loadFixture(deployFixture);
      await expect(bounty.connect(outsider).registerCompany(outsider.address, "Fake Co"))
        .to.be.revertedWithCustomError(bounty, "NotCouncil");
      await expect(bounty.connect(outsider).setCompanyActive(outsider.address, false))
        .to.be.revertedWithCustomError(bounty, "NotCouncil");
    });

    it("rejects invalid or repeated company registrations", async function () {
      const { bounty, council, bank, anaya } = await loadFixture(deployFixture);
      await expect(bounty.registerCompany(bank.address, "Again"))
        .to.be.revertedWithCustomError(bounty, "AlreadyRegistered").withArgs(bank.address);
      await expect(bounty.registerCompany(anaya.address, "Researcher as company"))
        .to.be.revertedWithCustomError(bounty, "AlreadyRegistered");
      await expect(bounty.registerCompany(ethers.ZeroAddress, "Nobody")).to.be.revertedWithCustomError(bounty, "InvalidInput");
      await expect(bounty.registerCompany(council.address, "Judge and party"))
        .to.be.revertedWithCustomError(bounty, "ConflictOfInterest");
    });

    it("researchers register themselves once, with a unique handle", async function () {
      const { bounty, anaya, ravi, kim, bank, council, outsider } = await loadFixture(deployFixture);
      await expect(bounty.connect(kim).registerResearcher("kernel_kim"))
        .to.emit(bounty, "ResearcherRegistered").withArgs(kim.address, "kernel_kim");
      await expect(bounty.connect(kim).registerResearcher("kim2")).to.be.revertedWithCustomError(bounty, "AlreadyRegistered");
      await expect(bounty.connect(anaya).registerResearcher("x")).to.be.revertedWithCustomError(bounty, "InvalidHandle");
      await expect(bounty.connect(bank).registerResearcher("bank_hacker")).to.be.revertedWithCustomError(bounty, "AlreadyRegistered");
      await expect(bounty.connect(council).registerResearcher("council")).to.be.revertedWithCustomError(bounty, "ConflictOfInterest");
      await expect(bounty.connect(outsider).registerResearcher("0xAnaya"))
        .to.be.revertedWithCustomError(bounty, "HandleTaken").withArgs("0xAnaya");
      const [accounts, info] = await bounty.getResearchers();
      expect(accounts).to.deep.equal([anaya.address, ravi.address, kim.address]);
      expect(info[2].handle).to.equal("kernel_kim");
    });

    it("a suspended company cannot open programs", async function () {
      const { bounty, cloud, outsider } = await loadFixture(deployFixture);
      await expect(bounty.setCompanyActive(cloud.address, false))
        .to.emit(bounty, "CompanyStatusChanged").withArgs(cloud.address, false);
      await expect(bounty.connect(cloud).createProgram("P", "s", PUBKEY, REWARDS, DAY, { value: ETH(5) }))
        .to.be.revertedWithCustomError(bounty, "NotActiveCompany");
      await expect(bounty.connect(outsider).createProgram("P", "s", PUBKEY, REWARDS, DAY, { value: ETH(5) }))
        .to.be.revertedWithCustomError(bounty, "NotActiveCompany");
      await expect(bounty.setCompanyActive(outsider.address, true)).to.be.revertedWithCustomError(bounty, "UnknownCompany");
    });
  });

  describe("Programs and escrow", function () {
    it("locks the reward money in the contract and stores the public key", async function () {
      const { bounty, bank } = await loadFixture(deployFixture);
      expect(await ethers.provider.getBalance(await bounty.getAddress())).to.equal(ETH(12));
      expect(await bounty.escrowBalance()).to.equal(ETH(12));
      const p = await bounty.getProgram(0);
      expect(p.company).to.equal(bank.address);
      expect(p.publicKey).to.equal(PUBKEY);
      expect(p.rewards[3]).to.equal(ETH(5));
      expect(p.escrow).to.equal(ETH(12));
      expect(p.responseWindow).to.equal(3 * DAY);
      expect(p.open).to.equal(true);
    });

    it("validates escrow, rewards and response window", async function () {
      const { bounty, cloud } = await loadFixture(deployFixture);
      const c = bounty.connect(cloud);
      await expect(c.createProgram("P", "s", PUBKEY, REWARDS, DAY, { value: ETH(4) }))
        .to.be.revertedWithCustomError(bounty, "InsufficientEscrow").withArgs(ETH(5), ETH(4));
      await expect(c.createProgram("P", "s", PUBKEY, [ETH(1), ETH(3), ETH(2), ETH(4)], DAY, { value: ETH(5) }))
        .to.be.revertedWithCustomError(bounty, "InvalidRewards");
      await expect(c.createProgram("P", "s", PUBKEY, [0, ETH(1), ETH(2), ETH(4)], DAY, { value: ETH(5) }))
        .to.be.revertedWithCustomError(bounty, "InvalidRewards");
      await expect(c.createProgram("P", "s", PUBKEY, REWARDS, 60, { value: ETH(5) }))
        .to.be.revertedWithCustomError(bounty, "InvalidWindow").withArgs(3600, 30 * DAY);
      await expect(c.createProgram("P", "s", "", REWARDS, DAY, { value: ETH(5) })).to.be.revertedWithCustomError(bounty, "InvalidInput");
    });

    it("only the owner can top up a program", async function () {
      const { bounty, bank, cloud } = await loadFixture(deployFixture);
      await expect(bounty.connect(bank).topUp(0, { value: ETH(3) }))
        .to.emit(bounty, "ProgramToppedUp").withArgs(0, ETH(3), ETH(15));
      await expect(bounty.connect(cloud).topUp(0, { value: ETH(1) })).to.be.revertedWithCustomError(bounty, "NotProgramOwner");
      await expect(bounty.connect(bank).topUp(7, { value: ETH(1) }))
        .to.be.revertedWithCustomError(bounty, "UnknownProgram").withArgs(7);
    });
  });

  describe("Submitting reports (proof of priority)", function () {
    it("records only the hashes and the block time", async function () {
      const { bounty, anaya } = await loadFixture(deployFixture);
      await expect(bounty.connect(anaya).submitReport(0, sha("pkg"), sha("report"), Sev.High))
        .to.emit(bounty, "ReportSubmitted").withArgs(0, 0, anaya.address, sha("report"), sha("pkg"), Sev.High);
      const r = await bounty.getReport(0);
      expect(r.researcher).to.equal(anaya.address);
      expect(r.submittedAt).to.equal(await time.latest());
      expect(r.status).to.equal(Status.Pending);
      expect(await bounty.responseDeadline(0)).to.equal(Number(r.submittedAt) + 3 * DAY);

      const byContent = await bounty.findReport(sha("report"));
      expect(byContent.found).to.equal(true);
      expect(byContent.reportId).to.equal(0);
      expect((await bounty.findReport(sha("pkg"))).found).to.equal(true);
      expect((await bounty.findReport(sha("edited report"))).found).to.equal(false);
      expect(await bounty.getResearcherReports(anaya.address)).to.deep.equal([0n]);
      expect(await bounty.getProgramReports(0)).to.deep.equal([0n]);
    });

    it("only registered researchers can submit, only to existing open programs", async function () {
      const { bounty, anaya, outsider } = await loadFixture(deployFixture);
      await expect(bounty.connect(outsider).submitReport(0, sha("a"), sha("b"), Sev.Low))
        .to.be.revertedWithCustomError(bounty, "NotResearcher");
      await expect(bounty.connect(anaya).submitReport(3, sha("a"), sha("b"), Sev.Low))
        .to.be.revertedWithCustomError(bounty, "UnknownProgram");
      await expect(bounty.connect(anaya).submitReport(0, ethers.ZeroHash, sha("b"), Sev.Low))
        .to.be.revertedWithCustomError(bounty, "InvalidInput");
    });

    it("rejects the same report hash twice (duplicate submission)", async function () {
      const { bounty, anaya, ravi } = await loadFixture(reportsFixture);
      await expect(bounty.connect(ravi).submitReport(0, sha("pkg-x"), sha("report-0"), Sev.High))
        .to.be.revertedWithCustomError(bounty, "DuplicateReport").withArgs(0);
      await expect(bounty.connect(anaya).submitReport(0, sha("pkg-1"), sha("report-y"), Sev.High))
        .to.be.revertedWithCustomError(bounty, "DuplicateReport").withArgs(1);
    });
  });

  describe("Company triage", function () {
    it("accepting a report pays the bounty from escrow automatically", async function () {
      const { bounty, bank, anaya } = await loadFixture(reportsFixture);
      const tx = bounty.connect(bank).acceptReport(0, Sev.High);
      await expect(tx).to.changeEtherBalances([anaya, bounty], [ETH("2.5"), ETH("-2.5")]);
      await expect(tx).to.emit(bounty, "BountyPaid").withArgs(0, anaya.address, ETH("2.5"));

      const r = await bounty.getReport(0);
      expect(r.status).to.equal(Status.Accepted);
      expect(r.awarded).to.equal(Sev.High);
      expect(r.payout).to.equal(ETH("2.5"));
      const p = await bounty.getProgram(0);
      expect(p.escrow).to.equal(ETH("9.5"));
      expect(p.paid).to.equal(ETH("2.5"));
      expect(p.openReports).to.equal(1);
      const me = await bounty.researchers(anaya.address);
      expect(me.earned).to.equal(ETH("2.5"));
      expect(me.accepted).to.equal(1);
      expect(await bounty.totalPaid()).to.equal(ETH("2.5"));
    });

    it("only the program owner can triage, and only once", async function () {
      const { bounty, bank, cloud, anaya } = await loadFixture(reportsFixture);
      await expect(bounty.connect(cloud).acceptReport(0, Sev.Low)).to.be.revertedWithCustomError(bounty, "NotProgramOwner");
      await expect(bounty.connect(anaya).rejectReport(0, "no")).to.be.revertedWithCustomError(bounty, "NotProgramOwner");
      await bounty.connect(bank).rejectReport(0, "Out of scope");
      await expect(bounty.connect(bank).acceptReport(0, Sev.Low))
        .to.be.revertedWithCustomError(bounty, "NotPending").withArgs(0);
      await expect(bounty.connect(bank).rejectReport(1, "")).to.be.revertedWithCustomError(bounty, "InvalidInput");
      await expect(bounty.connect(bank).acceptReport(9, Sev.Low)).to.be.revertedWithCustomError(bounty, "UnknownReport");
    });

    it("fails cleanly when the escrow cannot cover the reward, and works after a top-up", async function () {
      const { bounty, bank, anaya, ravi } = await loadFixture(reportsFixture);
      await bounty.connect(bank).acceptReport(1, Sev.Critical); // 12 - 5 = 7 left
      await bounty.connect(ravi).submitReport(0, sha("pkg-2"), sha("report-2"), Sev.Critical);
      await bounty.connect(bank).acceptReport(2, Sev.Critical); // 7 - 5 = 2 left
      await expect(bounty.connect(bank).acceptReport(0, Sev.High))
        .to.be.revertedWithCustomError(bounty, "InsufficientEscrow").withArgs(ETH("2.5"), ETH(2));
      expect((await bounty.getReport(0)).status).to.equal(Status.Pending); // nothing changed
      await bounty.connect(bank).topUp(0, { value: ETH(1) });
      await expect(bounty.connect(bank).acceptReport(0, Sev.High)).to.changeEtherBalance(anaya, ETH("2.5"));
    });

    it("a duplicate must point to an earlier report in the same program", async function () {
      const { bounty, bank, cloud, anaya } = await loadFixture(reportsFixture);
      await expect(bounty.connect(bank).markDuplicate(0, 1)).to.be.revertedWithCustomError(bounty, "InvalidDuplicate");
      await expect(bounty.connect(bank).markDuplicate(1, 1)).to.be.revertedWithCustomError(bounty, "InvalidDuplicate");
      // a report in another program cannot be the original
      await bounty.connect(cloud).createProgram("Portal", "s", PUBKEY, REWARDS, DAY, { value: ETH(5) });
      await bounty.connect(anaya).submitReport(1, sha("pkg-c"), sha("report-c"), Sev.Low); // report 2, program 1
      await bounty.connect(anaya).submitReport(0, sha("pkg-d"), sha("report-d"), Sev.Low); // report 3, program 0
      await expect(bounty.connect(bank).markDuplicate(3, 2)).to.be.revertedWithCustomError(bounty, "InvalidDuplicate");
      const tx = await bounty.connect(bank).markDuplicate(1, 0);
      const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
      await expect(tx).to.emit(bounty, "ReportMarkedDuplicate").withArgs(1, 0, block.timestamp + 3 * DAY);
      const r = await bounty.getReport(1);
      expect(r.status).to.equal(Status.Duplicate);
      expect(r.duplicateOf).to.equal(0);
    });
  });

  describe("Escalation to the arbiter", function () {
    it("an ignored report can only be escalated after the response deadline", async function () {
      const { bounty, ravi } = await loadFixture(reportsFixture);
      const deadline = await bounty.responseDeadline(1);
      await expect(bounty.connect(ravi).escalate(1)).to.be.revertedWithCustomError(bounty, "TooEarly");
      await time.increaseTo(deadline - 10n);
      await expect(bounty.connect(ravi).escalate(1))
        .to.be.revertedWithCustomError(bounty, "TooEarly").withArgs(anyValue, deadline);
      await time.increaseTo(deadline);
      await expect(bounty.connect(ravi).escalate(1)).to.emit(bounty, "ReportEscalated").withArgs(1, ravi.address, Status.Pending);
      expect((await bounty.getReport(1)).dispute).to.equal(Dispute.Open);
    });

    it("once escalated, the company can no longer decide alone", async function () {
      const { bounty, bank, ravi } = await loadFixture(reportsFixture);
      await time.increase(3 * DAY);
      await bounty.connect(ravi).escalate(1);
      await expect(bounty.connect(bank).acceptReport(1, Sev.Low)).to.be.revertedWithCustomError(bounty, "NotPending");
      await expect(bounty.connect(ravi).escalate(1)).to.be.revertedWithCustomError(bounty, "CannotEscalate");
    });

    it("a rejected report can be appealed at once, but only within the appeal window", async function () {
      const { bounty, bank, anaya, ravi } = await loadFixture(reportsFixture);
      await bounty.connect(bank).rejectReport(0, "Works as intended");
      await bounty.connect(bank).rejectReport(1, "Not reproducible");
      await expect(bounty.connect(anaya).escalate(0)).to.emit(bounty, "ReportEscalated").withArgs(0, anaya.address, Status.Rejected);
      await time.increase(3 * DAY);
      await expect(bounty.connect(ravi).escalate(1)).to.be.revertedWithCustomError(bounty, "AppealWindowClosed");
    });

    it("only the reporting researcher can escalate, and never an accepted report", async function () {
      const { bounty, bank, anaya, ravi } = await loadFixture(reportsFixture);
      await bounty.connect(bank).rejectReport(0, "Out of scope");
      await expect(bounty.connect(ravi).escalate(0)).to.be.revertedWithCustomError(bounty, "NotReportResearcher");
      await bounty.connect(bank).acceptReport(1, Sev.Critical);
      await expect(bounty.connect(ravi).escalate(1)).to.be.revertedWithCustomError(bounty, "CannotEscalate").withArgs(1);
      await expect(bounty.connect(anaya).escalate(5)).to.be.revertedWithCustomError(bounty, "UnknownReport");
    });

    it("the arbiter can force payout from escrow when the researcher is right", async function () {
      const { bounty, bank, council, ravi, outsider } = await loadFixture(reportsFixture);
      await bounty.connect(bank).markDuplicate(1, 0);
      await bounty.connect(ravi).escalate(1);
      await expect(bounty.connect(outsider).resolveDispute(1, true, Sev.Critical)).to.be.revertedWithCustomError(bounty, "NotCouncil");
      await expect(bounty.connect(bank).resolveDispute(1, true, Sev.Critical)).to.be.revertedWithCustomError(bounty, "NotCouncil");

      const tx = bounty.connect(council).resolveDispute(1, true, Sev.Critical);
      await expect(tx).to.changeEtherBalances([ravi, bounty, bank], [ETH(5), ETH(-5), 0]);
      await expect(tx).to.emit(bounty, "DisputeResolved").withArgs(1, true, Sev.Critical, ETH(5));
      const r = await bounty.getReport(1);
      expect(r.dispute).to.equal(Dispute.ResearcherWon);
      expect(r.payout).to.equal(ETH(5));
      expect((await bounty.researchers(ravi.address)).earned).to.equal(ETH(5));
      await expect(bounty.resolveDispute(1, true, Sev.Critical)).to.be.revertedWithCustomError(bounty, "NoOpenDispute").withArgs(1);
    });

    it("the arbiter can dismiss a dispute without any payment", async function () {
      const { bounty, bank, anaya } = await loadFixture(reportsFixture);
      await bounty.connect(bank).rejectReport(0, "Self-XSS only");
      await bounty.connect(anaya).escalate(0);
      await expect(bounty.resolveDispute(0, false, Sev.Low)).to.changeEtherBalance(anaya, 0);
      expect((await bounty.getReport(0)).dispute).to.equal(Dispute.CompanyWon);
      expect((await bounty.getProgram(0)).escrow).to.equal(ETH(12));
    });
  });

  describe("Closing a program", function () {
    it("the escrow stays locked while reports or appeals are open", async function () {
      const { bounty, bank, anaya } = await loadFixture(reportsFixture);
      await expect(bounty.connect(bank).closeProgram(0)).to.be.revertedWithCustomError(bounty, "ProgramHasOpenReports").withArgs(2);
      await bounty.connect(bank).acceptReport(0, Sev.High);
      await bounty.connect(bank).rejectReport(1, "Out of scope");
      const until = (await bounty.getProgram(0)).appealsOpenUntil;
      await expect(bounty.connect(bank).closeProgram(0)).to.be.revertedWithCustomError(bounty, "AppealsStillOpen").withArgs(until);
      await expect(bounty.connect(anaya).closeProgram(0)).to.be.revertedWithCustomError(bounty, "NotProgramOwner");

      await time.increaseTo(until);
      await expect(bounty.connect(bank).closeProgram(0)).to.changeEtherBalance(bank, ETH("9.5"));
      expect((await bounty.getProgram(0)).open).to.equal(false);
      expect(await bounty.escrowBalance()).to.equal(0);
      await expect(bounty.connect(anaya).submitReport(0, sha("late"), sha("late-r"), Sev.Low))
        .to.be.revertedWithCustomError(bounty, "ProgramNotOpen").withArgs(0);
      await expect(bounty.connect(bank).topUp(0, { value: 1 })).to.be.revertedWithCustomError(bounty, "ProgramNotOpen");
    });

    it("a malicious company cannot re-enter closeProgram to withdraw twice", async function () {
      const { bounty, council } = await loadFixture(deployFixture);
      const attacker = await ethers.deployContract("ReentrantCompany", [await bounty.getAddress()]);
      await bounty.connect(council).registerCompany(await attacker.getAddress(), "Evil Corp");
      await attacker.open(PUBKEY, { value: ETH(4) });
      expect(await bounty.escrowBalance()).to.equal(ETH(16)); // 12 (bank) + 4 (attacker)

      await attacker.close();
      expect(await attacker.attempts()).to.equal(1); // it tried ...
      expect(await attacker.reentered()).to.equal(false); // ... and failed
      expect(await attacker.lastError()).to.equal(bounty.interface.encodeErrorResult("Reentrancy", []));
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(ETH(4));
      expect(await bounty.escrowBalance()).to.equal(ETH(12)); // the bank's escrow is untouched
    });

    it("a failed ETH transfer reverts the whole close and nothing changes", async function () {
      const { bounty } = await loadFixture(deployFixture);
      const company = await ethers.deployContract("ReentrantCompany", [await bounty.getAddress()]);
      await bounty.registerCompany(await company.getAddress(), "No-Receive Ltd");
      await company.open(PUBKEY, { value: ETH(4) });
      await company.setRefuseEth(true);
      await expect(company.close()).to.be.revertedWithCustomError(bounty, "TransferFailed");
      const p = await bounty.getProgram(1);
      expect(p.open).to.equal(true);
      expect(p.escrow).to.equal(ETH(4));
    });
  });

  describe("Leaderboard data", function () {
    it("tracks submissions, accepted reports and earnings per researcher", async function () {
      const { bounty, bank, anaya, ravi } = await loadFixture(reportsFixture);
      await bounty.connect(bank).acceptReport(0, Sev.Medium);
      await bounty.connect(bank).acceptReport(1, Sev.Critical);
      const [accounts, info] = await bounty.getResearchers();
      const byAddr = Object.fromEntries(accounts.map((a, i) => [a, info[i]]));
      expect(byAddr[anaya.address].earned).to.equal(ETH(1));
      expect(byAddr[ravi.address].earned).to.equal(ETH(5));
      expect(byAddr[ravi.address].submitted).to.equal(1);
      expect(byAddr[ravi.address].accepted).to.equal(1);
      const [companies, cinfo] = await bounty.getCompanies();
      expect(companies.length).to.equal(2);
      expect(cinfo[0].name).to.equal("PaySecure Bank (demo)");
      expect(await bounty.programCount()).to.equal(1);
      expect(await bounty.reportCount()).to.equal(2);
    });
  });
});
