import { beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "starknet";
import { MarketZapWallet } from "../starkzap";

const connectCartridgeMock = vi.fn();
const connectWalletMock = vi.fn();

vi.mock("starkzap", () => {
  class MockStarkSDK {
    connectWallet = connectWalletMock;
    connectCartridge = connectCartridgeMock;

    getProvider() {
      return {
        callContract: vi.fn(),
      };
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
    const factoryAddress =
      "0x16c950afea1bcd049c82bb917260958070bae2484baf5fa43b7d014f2f83888";
    const provider = {
      waitForTransaction: vi.fn().mockResolvedValue({
        events: [
          {
            from_address:
              "0x016c950afea1bcd049c82bb917260958070bae2484baf5fa43b7d014f2f83888",
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
});
