import { beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "starknet";
import { MarketZapWallet } from "../starkzap";
import { getContractAddress } from "../contracts";

const connectCartridgeMock = vi.fn();
const connectWalletMock = vi.fn();
const sdkProviderMock = {
  callContract: vi.fn(),
  waitForTransaction: vi.fn(),
};

vi.mock("starkzap", () => {
  class MockStarkSDK {
    connectWallet = connectWalletMock;
    connectCartridge = connectCartridgeMock;

    getProvider() {
      return sdkProviderMock;
    }
  }

  class MockStarkSigner {
    constructor(_privateKey: string) {}
  }

  class MockContract {
    constructor(_config: unknown) {}

    populate(entrypoint: string, calldata: unknown[]) {
      return {
        contractAddress: "0xcontract",
        entrypoint,
        calldata,
      };
    }
  }

  return {
    StarkSDK: MockStarkSDK,
    StarkSigner: MockStarkSigner,
    Contract: MockContract,
  };
});

function createWallet(options?: {
  address?: string;
  preflight?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
  provider?: {
    waitForTransaction: ReturnType<typeof vi.fn>;
  };
}) {
  const wait = vi.fn().mockResolvedValue(undefined);
  const provider = options?.provider ?? {
    waitForTransaction: vi.fn().mockResolvedValue({}),
  };

  return {
    address: options?.address ?? "0x123",
    preflight:
      options?.preflight ??
      vi.fn().mockResolvedValue({
        ok: true,
      }),
    execute:
      options?.execute ??
      vi.fn().mockResolvedValue({
        transactionHash: "0xtx",
        wait,
      }),
    signMessage: vi.fn(),
    ensureReady: vi.fn(),
    disconnect: vi.fn(),
    getAccount: vi.fn(),
    getProvider: vi.fn(() => provider),
  } as any;
}

describe("MarketZapWallet StarkZap integration", () => {
  beforeEach(() => {
    connectCartridgeMock.mockReset();
    connectWalletMock.mockReset();
    sdkProviderMock.callContract.mockReset();
    sdkProviderMock.waitForTransaction.mockReset();
  });

  it("passes Cartridge options to the SDK and records cartridge capabilities", async () => {
    connectCartridgeMock.mockResolvedValue(createWallet({ address: "0xcartridge" }));

    const wallet = new MarketZapWallet("sepolia");

    await wallet.connectCartridge({
      policies: [{ target: "0x123", method: "deposit" }],
      preset: "market-zap",
      url: "https://controller.example",
    });

    expect(connectCartridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feeMode: "user_pays",
        policies: [{ target: "0x123", method: "deposit" }],
        preset: "market-zap",
        url: "https://controller.example",
      }),
    );
    expect(wallet.getState()).toMatchObject({
      connected: true,
      address: "0xcartridge",
      connectionKind: "cartridge",
      supportsPreflight: true,
      gasless: true,
    });
  });

  it("records external wallet capabilities", async () => {
    const externalWallet = new MarketZapWallet("sepolia", {
      feeMode: "sponsored",
    });
    externalWallet.connectWithWallet(createWallet({ address: "0xext" }), "external");

    expect(externalWallet.getState()).toMatchObject({
      connectionKind: "external",
      supportsPreflight: false,
      gasless: false,
    });
  });

  it("runs Cartridge preflight before executing multicalls", async () => {
    const preflight = vi.fn().mockResolvedValue({ ok: true });
    const execute = vi.fn().mockResolvedValue({
      transactionHash: "0xabc",
      wait: vi.fn().mockResolvedValue(undefined),
    });
    connectCartridgeMock.mockResolvedValue(
      createWallet({
        address: "0xcartridge",
        preflight,
        execute,
      }),
    );

    const wallet = new MarketZapWallet("sepolia");
    await wallet.connectCartridge({
      policies: [{ target: "0xexchange", method: "deposit" }],
      preset: "market-zap",
    });

    const result = await wallet.approveAndDeposit("0x123", 10n);

    expect(result).toMatchObject({ success: true, txHash: "0xabc" });
    expect(connectCartridgeMock).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        feeMode: "user_pays",
        calls: expect.arrayContaining([
          expect.objectContaining({ entrypoint: "approve" }),
          expect.objectContaining({ entrypoint: "deposit" }),
        ]),
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("surfaces Cartridge preflight failures without executing the transaction", async () => {
    const preflight = vi.fn().mockResolvedValue({
      ok: false,
      reason: "Session policy does not allow deposit",
    });
    const execute = vi.fn();
    connectCartridgeMock.mockResolvedValue(
      createWallet({
        address: "0xcartridge",
        preflight,
        execute,
      }),
    );

    const wallet = new MarketZapWallet("sepolia");
    await wallet.connectCartridge();

    await expect(wallet.approveAndDeposit("0x123", 10n)).resolves.toMatchObject({
      success: false,
      error: "Session policy does not allow deposit",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("extracts MarketCreated even when receipt values are padded differently", async () => {
    const marketCreatedSelector = hash.getSelectorFromName("MarketCreated");
    const factoryAddress = getContractAddress("MarketFactory", "sepolia");
    const provider = {
      waitForTransaction: vi.fn().mockResolvedValue({
        events: [
          {
            from_address: `0x0${factoryAddress.slice(2)}`,
            keys: [
              `0x${BigInt(marketCreatedSelector).toString(16).padStart(64, "0")}`,
              "0x000000000000000000000000000000000000000000000000000000000000002a",
            ],
            data: [
              "0x00000000000000000000000000000000000000000000000000000000000000ab",
            ],
          },
        ],
      }),
    };
    connectCartridgeMock.mockResolvedValue(
      createWallet({
        address: "0xcartridge",
        provider,
      }),
    );

    const wallet = new MarketZapWallet("sepolia");
    await wallet.connectCartridge();

    const result = await wallet.approveAndCreateMarket("0xusdc", 20n, {
      question: "Will this be parsed correctly?",
      category: "crypto",
      outcomes: ["Yes", "No"],
      collateralToken: "0xusdc",
      resolutionTime: Math.floor(Date.now() / 1000) + 3600,
      marketType: "public",
    });

    expect(result).toMatchObject({
      success: true,
      txHash: "0xtx",
      marketId: 42,
      conditionId:
        "0x00000000000000000000000000000000000000000000000000000000000000ab",
    });
  });

  it("uses the SDK RPC provider for external wallet reads and receipt polling", async () => {
    const marketCreatedSelector = hash.getSelectorFromName("MarketCreated");
    const factoryAddress = getContractAddress("MarketFactory", "sepolia");
    const accountWaitForTransaction = vi.fn().mockRejectedValue(
      new Error("should not use wallet provider wait"),
    );
    const externalAccount = {
      address: "0xext",
      provider: {
        waitForTransaction: accountWaitForTransaction,
      },
      getChainId: vi.fn().mockResolvedValue("0x534e5f5345504f4c4941"),
      execute: vi.fn().mockResolvedValue({
        transactionHash: "0xext-tx",
      }),
      signMessage: vi.fn(),
      waitForTransaction: accountWaitForTransaction,
    } as any;

    sdkProviderMock.waitForTransaction.mockResolvedValue({
      events: [
        {
          from_address: factoryAddress,
          keys: [
            `0x${BigInt(marketCreatedSelector).toString(16).padStart(64, "0")}`,
            "0x2a",
          ],
          data: ["0xab"],
        },
      ],
    });

    const wallet = new MarketZapWallet("sepolia");
    await wallet.connectWithExternalAccount(
      externalAccount,
      "0x534e5f5345504f4c4941",
    );

    const question = "Will the external adapter use the shared RPC?";
    const result = await wallet.approveAndCreateMarket("0xusdc", 20n, {
      question,
      category: "crypto",
      outcomes: ["Yes", "No"],
      collateralToken: "0xusdc",
      resolutionTime: Math.floor(Date.now() / 1000) + 3600,
      marketType: "public",
    });

    expect(result).toMatchObject({
      success: true,
      txHash: "0xext-tx",
      marketId: 42,
      conditionId: "0xab",
    });
    const submittedCalls = externalAccount.execute.mock.calls[0][0];
    const createCall = submittedCalls.find(
      (call: { entrypoint: string }) => call.entrypoint === "create_market",
    );
    expect(createCall).toBeDefined();
    if (!createCall) {
      throw new Error("create_market call was not submitted");
    }
    // External wallets get pre-compiled flat calldata with proper ByteArray serialization
    // ByteArray("Will the external adapter use the shared RPC?") = 1 full chunk + 14-byte pending
    expect(createCall.calldata[0]).toBe("1"); // data.length
    expect(createCall.calldata[1]).toBe(
      "0x57696c6c207468652065787465726e616c2061646170746572207573652074",
    ); // data[0] (31-byte chunk)
    expect(createCall.calldata[2]).toBe("0x686520736861726564205250433f"); // pending_word
    expect(createCall.calldata[3]).toBe("14"); // pending_word_len
    // Span<felt252> outcomes
    expect(createCall.calldata[4]).toBe("2"); // outcomes length
    expect(createCall.calldata[5]).toBe(hash.getSelectorFromName("Yes"));
    expect(createCall.calldata[6]).toBe(hash.getSelectorFromName("No"));
    expect(sdkProviderMock.waitForTransaction).toHaveBeenCalledTimes(2);
    expect(accountWaitForTransaction).not.toHaveBeenCalled();
  });
});
