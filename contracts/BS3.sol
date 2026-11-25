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

interface IP {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256, int256);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IW {
    function withdraw(uint256) external;
}

/// @title BS3 - PancakeSwap V2 + V3 多钱包合并代卖合约
/// @notice sell() 走薄饼 V2 Router；sell3() 直连薄饼 V3 Pool 并在回调中付款；BNB 按实际到合约币量退回各钱包
contract BS3 {
    address constant R = 0x10ED43C718714eb63d5aA57B78B54704E256024E; // PancakeSwap V2 Router
    address constant W = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c; // WBNB
    uint160 constant MINP = 4295128740;
    uint160 constant MAXP = 1461446703485210103287273052203988822378723970341;

    mapping(address => bool) public op;
    address private P;
    address private T;

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

    function _pull(address t, address[] calldata w) internal returns (uint256[] memory g, uint256 tot) {
        uint256 n = w.length;
        g = new uint256[](n);
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
    }

    function _pay(address t, address[] calldata w, uint256[] memory g, uint256 tot, uint256 out) internal {
        for (uint256 i; i < w.length; i++) {
            if (g[i] > 0) {
                (bool s, ) = w[i].call{value: (out * g[i]) / tot}("");
                require(s, "pay");
            }
        }
        emit Sold(t, tot, out);
    }

    // 薄饼 V2 批量代卖
    function sell(address t, address[] calldata w, uint256 minOut) external {
        require(op[msg.sender], "op");
        (uint256[] memory g, uint256 tot) = _pull(t, w);
        (bool ok2, ) = t.call(abi.encodeWithSelector(0x095ea7b3, R, tot));
        require(ok2, "apv");
        address[] memory p = new address[](2);
        p[0] = t;
        p[1] = W;
        uint256 e0 = address(this).balance;
        IR(R).swapExactTokensForETHSupportingFeeOnTransferTokens(tot, minOut, p, address(this), block.timestamp);
        _pay(t, w, g, tot, address(this).balance - e0);
    }

    // 直连薄饼 V3 池批量代卖，pool 由操作员指定，合约校验包含 t 与 WBNB
    function sell3(address t, address pool, address[] calldata w, uint256 minOut) external {
        require(op[msg.sender], "op");
        address a0 = IP(pool).token0();
        address a1 = IP(pool).token1();
        bool z = a0 == t;
        require((z && a1 == W) || (a0 == W && a1 == t), "pool");
        (uint256[] memory g, uint256 tot) = _pull(t, w);
        uint256 wb0 = _bal(W, address(this));
        P = pool;
        T = t;
        IP(pool).swap(address(this), z, int256(tot), z ? MINP : MAXP, "");
        P = address(0);
        T = address(0);
        uint256 out = _bal(W, address(this)) - wb0;
        require(out >= minOut, "slip");
        uint256 e0 = address(this).balance;
        IW(W).withdraw(out);
        _pay(t, w, g, tot, address(this).balance - e0);
    }

    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == P && P != address(0), "cb");
        uint256 amt = uint256(d0 > 0 ? d0 : d1);
        (bool ok, bytes memory d) = T.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, amt));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "tf");
    }

    // 紧急救援误转入合约的代币
    function rescue(address t, address to) external {
        require(op[msg.sender], "op");
        uint256 b = _bal(t, address(this));
        if (b > 0) {
            (bool ok, ) = t.call(abi.encodeWithSelector(0xa9059cbb, to, b));
            require(ok, "rescue");
        }
    }

    receive() external payable {}
}
