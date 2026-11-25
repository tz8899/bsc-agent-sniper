// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IR {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title BS - PancakeSwap V2 多钱包合并代卖合约
/// @notice 仅白名单操作员可调用：拉取各钱包 min(余额, 对本合约授权) 的代币，合并走薄饼 V2 卖出，BNB 按实际到合约的代币比例原路退回各钱包
contract BS {
    address constant R = 0x10ED43C718714eb63d5aA57B78B54704E256024E; // PancakeSwap V2 Router
    address constant W = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c; // WBNB

    mapping(address => bool) public op;
    event Sold(address indexed t, uint256 tok, uint256 bnb);

    constructor(address[] memory o) {
        for (uint256 i; i < o.length; i++) {
            op[o[i]] = true;
        }
    }

    function _bal(address t, address a) internal view returns (uint256 r) {
        (bool ok, bytes memory d) = t.staticcall(abi.encodeWithSelector(0x70a08231, a));
        if (ok && d.length >= 32) r = abi.decode(d, (uint256));
    }

    function _alw(address t, address a) internal view returns (uint256 r) {
        (bool ok, bytes memory d) = t.staticcall(abi.encodeWithSelector(0xdd62ed3e, a, address(this)));
        if (ok && d.length >= 32) r = abi.decode(d, (uint256));
    }

    // 拉各钱包 min(余额, 对本合约授权) 的币，合并薄饼 V2 卖，BNB 按各自到合约的币量退回原钱包
    function sell(address t, address[] calldata w, uint256 minOut) external {
        require(op[msg.sender], "op");
        uint256 n = w.length;
        uint256[] memory g = new uint256[](n);
        uint256 tot;
        for (uint256 i; i < n; i++) {
            uint256 a = _bal(t, w[i]);
            uint256 al = _alw(t, w[i]);
            if (al < a) a = al;
            if (a == 0) continue;
            uint256 b0 = _bal(t, address(this));
            (bool ok, bytes memory d) = t.call(abi.encodeWithSelector(0x23b872dd, w[i], address(this), a));
            if (!ok || (d.length > 0 && !abi.decode(d, (bool)))) continue;
            g[i] = _bal(t, address(this)) - b0;
            tot += g[i];
        }
        require(tot > 0, "none");
        (bool ok2, ) = t.call(abi.encodeWithSelector(0x095ea7b3, R, tot));
        require(ok2, "apv");
        address[] memory p = new address[](2);
        p[0] = t;
        p[1] = W;
        uint256 e0 = address(this).balance;
        IR(R).swapExactTokensForETHSupportingFeeOnTransferTokens(tot, minOut, p, address(this), block.timestamp);
        uint256 out = address(this).balance - e0;
        for (uint256 i; i < n; i++) {
            if (g[i] > 0) {
                (bool s, ) = w[i].call{value: (out * g[i]) / tot}("");
                require(s, "pay");
            }
        }
        emit Sold(t, tot, out);
    }

    receive() external payable {}
}
