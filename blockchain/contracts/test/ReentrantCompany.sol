// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../BugBounty.sol";

/// @dev TEST ONLY. A malicious "company" contract used by the Hardhat tests.
///      - default: when it receives its escrow refund it calls closeProgram() again from
///        inside the transfer (a re-entrancy attack) to try to withdraw twice;
///      - refuseEth = true: it rejects every incoming payment (to test TransferFailed).
contract ReentrantCompany {
    BugBounty private immutable target;
    uint256 public programId;
    uint256 public attempts;
    bool public reentered;       // true would mean the attack worked
    bytes public lastError;      // revert data of the nested call
    bool public refuseEth;

    constructor(BugBounty bounty) {
        target = bounty;
    }

    function open(string calldata publicKey) external payable {
        uint256[4] memory rewards = [uint256(1 ether), 2 ether, 3 ether, 4 ether];
        programId = target.createProgram{value: msg.value}("Evil Corp", "*", publicKey, rewards, 1 days);
    }

    function setRefuseEth(bool value) external {
        refuseEth = value;
    }

    function close() external {
        target.closeProgram(programId);
    }

    receive() external payable {
        if (refuseEth) revert("no thanks");
        if (attempts == 0) {
            attempts = 1;
            try target.closeProgram(programId) {
                reentered = true;
            } catch (bytes memory reason) {
                lastError = reason;
            }
        }
    }
}
