// LOCAL-MODELS-HF-1 item 7: sizing a model from the GGUF files of a quantization repository (real file lists from the
// Hub, test/fixtures/pool-hf/blobs): Q4_K_M or its Unsloth dynamic form or a native MXFP4 as the 4-bit file, Q8_0 as the
// 8-bit one, split files summed and checked complete, draft/vision/imatrix side files left out, and whose repository
// may be used.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orderRepos, pickQuants, TRUSTED_QUANTIZERS, type Sibling } from "../../src/pool/hf/ggufs.ts";
import { HF_FIXTURES } from "../helpers/hf-fixtures.ts";

const siblings = (repo: string): Sibling[] => (JSON.parse(readFileSync(join(HF_FIXTURES, "blobs", `${repo.replace("/", "__")}.json`), "utf8")) as { siblings: Sibling[] }).siblings;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe("one file per quantization", () => {
  test("unsloth Qwen3.8-27B has no plain Q4_K_M: its dynamic UD-Q4_K_M is the 4-bit file; the MTP draft and BF16 shards are not", () => {
    const q = pickQuants(siblings("unsloth/Qwen3.8-27B-GGUF"));
    expect(q.q4).toEqual({
      kind: "UD-Q4_K_M", bytes: 16464440224,
      files: [{ path: "Qwen3.8-27B-UD-Q4_K_M.gguf", size: 16464440224, sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482" }],
    });
    expect(q.q8).toMatchObject({ kind: "Q8_0", bytes: 29047086048 });
  });

  test("plain Q4_K_M and Q8_0 (lmstudio-community); the vision projector is not part of the model", () => {
    const q = pickQuants(siblings("lmstudio-community/Qwen3.8-27B-GGUF"));
    expect(q.q4).toMatchObject({ kind: "Q4_K_M", bytes: 16810714336 });
    expect(q.q8).toMatchObject({ kind: "Q8_0", bytes: 29047084256 });
  });

  test("ggml-org: the mtp-, dflash- and mmproj- Q8_0 files are side files, not the 8-bit model", () => {
    const q = pickQuants(siblings("ggml-org/Qwen3.8-27B-GGUF"));
    expect(q.q4).toMatchObject({ kind: "Q4_K_M", bytes: 18973870528 });
    expect(q.q8).toMatchObject({ kind: "Q8_0", bytes: 28595763648 });
    expect(q.q8!.files.map((f) => f.path)).toEqual(["Qwen3.8-27B-Q8_0.gguf"]);
  });

  test("a native MXFP4 release is the 4-bit file when there is no Q4_K_M (gpt-oss), with no 8-bit; the eagle3 draft is ignored", () => {
    const q = pickQuants(siblings("ggml-org/gpt-oss-20b-GGUF"));
    expect(q.q4).toMatchObject({ kind: "MXFP4", bytes: 12109566624 });
    expect(q.q8).toBeNull();
  });

  test("plain Q4_K_M beats MXFP4 when a repository has both", () => {
    const q = pickQuants(siblings("unsloth/gpt-oss-20b-GGUF"));
    expect(q.q4).toMatchObject({ kind: "Q4_K_M", bytes: 11624759488 });
    expect(q.q8).toMatchObject({ kind: "Q8_0", bytes: 12109567168 });
  });

  test("lower-case names (ornith-1.0-35b-Q4_K_M.gguf) and a repository with one or both", () => {
    expect(pickQuants(siblings("ornith-ai/Ornith-1.0-35B-GGUF")).q4).toMatchObject({ kind: "Q4_K_M", bytes: 21166757760 });
    // Only Q8_0 and BF16 shards: no 4-bit file, so the model is not runnable from this repository.
    const q = pickQuants(siblings("ggml-org/gemma-4-E4B-it-GGUF"));
    expect(q.q4).toBeNull();
    expect(q.q8).toMatchObject({ kind: "Q8_0", bytes: 8031242688 });
  });
});

describe("split files", () => {
  test("shards in a folder are summed in order and all must be there (bartowski Qwen3.8-Flash-Next: 4 for Q4_K_M, 6 for Q8_0)", () => {
    const q = pickQuants(siblings("bartowski/Qwen3.8-Flash-Next-GGUF"));
    expect(q.q4!.kind).toBe("Q4_K_M");
    expect(q.q4!.files.map((f) => f.path.split("/").pop())).toEqual([1, 2, 3, 4].map((i) => `Qwen3.8-Flash-Next-Q4_K_M-0000${i}-of-00004.gguf`));
    expect(q.q4!.files[0]!.path).toBe("Qwen3.8-Flash-Next-Q4_K_M/Qwen3.8-Flash-Next-Q4_K_M-00001-of-00004.gguf");
    expect(q.q4!.bytes).toBe(sum([39956571840, 39505063904, 39652077728, 485316608]));
    expect(q.q8!.files).toHaveLength(6);
    expect(q.q8!.bytes).toBe(sum([699524096, 54400261312, 39389533152, 39521324096, 39532800992, 14717325888]));
  });

  test("a shard missing from the listing means the quantization is not usable", () => {
    const all = siblings("bartowski/Qwen3.8-Flash-Next-GGUF");
    const lost = all.filter((s) => !s.rfilename.endsWith("Q4_K_M-00003-of-00004.gguf"));
    expect(pickQuants(lost).q4).toBeNull();
    expect(pickQuants(lost).q8).not.toBeNull();
  });

  test("unsloth's Flash-Next repository has Q8_0 shards but no Q4_K_M listed: no 4-bit file", () => {
    const q = pickQuants(siblings("unsloth/Qwen3.8-Flash-Next-GGUF"));
    expect(q.q4).toBeNull();
    expect(q.q8!.files).toHaveLength(6);
  });
});

describe("what is not accepted", () => {
  test("no size, a size that is not a count of bytes, or a path that could leave the folder", () => {
    expect(pickQuants([{ rfilename: "m-Q4_K_M.gguf" }]).q4).toBeNull();
    expect(pickQuants([{ rfilename: "m-Q4_K_M.gguf", size: -5 }]).q4).toBeNull();
    expect(pickQuants([{ rfilename: "../m-Q4_K_M.gguf", size: 5 }]).q4).toBeNull();
    expect(pickQuants([{ rfilename: "a/../m-Q4_K_M.gguf", size: 5 }]).q4).toBeNull();
    expect(pickQuants([{ rfilename: "m-Q4_K_M.gguf", size: 5e13 }]).q4).toBeNull();
    expect(pickQuants([{ rfilename: "m-Q4_K_M.gguf", size: 4_000_000_000 }]).q4).toMatchObject({ bytes: 4_000_000_000, files: [{ path: "m-Q4_K_M.gguf", sha256: null }] });
  });

  test("a sha256 that is not 64 hex characters is dropped (null), not trusted", () => {
    const q = pickQuants([{ rfilename: "m-Q4_K_M.gguf", size: 10, lfs: { sha256: "xyz", size: 10 } }]);
    expect(q.q4!.files[0]!.sha256).toBeNull();
  });
});

describe("whose repositories", () => {
  test("only the maker and four known quantizers, by downloads; an unknown account's 'uncensored' copy or special format never sizes a model", () => {
    expect([...TRUSTED_QUANTIZERS]).toEqual(["unsloth", "bartowski", "lmstudio-community", "ggml-org"]);
    const quants = [
      { id: "cdiamond/Qwen3.8-27B-iMatrix-NVFP4-MTP-GGUF", downloads: 4173935 },
      { id: "prism-ml/Ternary-Bonsai-2-27B-gguf", downloads: 3766691 },
      { id: "lmstudio-community/Qwen3.8-27B-GGUF", downloads: 1353198 },
      { id: "unsloth/Qwen3.8-27B-GGUF", downloads: 6271224 },
      { id: "Qwen/Qwen3.8-27B-GGUF", downloads: 10 },
      { id: "bartowski/Qwen_Qwen3.8-27B-GGUF", downloads: 90000 },
    ];
    // By downloads among the trusted ones, three at most (the maker's own, with 10 downloads here, comes fourth).
    expect(orderRepos("Qwen", quants, [])).toEqual(["unsloth/Qwen3.8-27B-GGUF", "lmstudio-community/Qwen3.8-27B-GGUF", "bartowski/Qwen_Qwen3.8-27B-GGUF"]);
    expect(orderRepos("Qwen", quants.filter((q) => !q.id.startsWith("unsloth")), [])).toEqual(["lmstudio-community/Qwen3.8-27B-GGUF", "bartowski/Qwen_Qwen3.8-27B-GGUF", "Qwen/Qwen3.8-27B-GGUF"]);
  });

  test("a repository that carries multi-token-prediction heads ('-MTP-') is tried after the plain ones, however many downloads it has; alone, it is used", () => {
    // Real: unsloth/Qwen3.6-27B-MTP-GGUF has more downloads than unsloth/Qwen3.6-27B-GGUF; the pinned runtime should load the plain file first.
    const quants = [{ id: "unsloth/Qwen3.6-27B-MTP-GGUF", downloads: 900_000 }, { id: "unsloth/Qwen3.6-27B-GGUF", downloads: 500_000 }, { id: "lmstudio-community/Qwen3.6-27B-GGUF", downloads: 100_000 }];
    expect(orderRepos("Qwen", quants, [])).toEqual(["unsloth/Qwen3.6-27B-GGUF", "lmstudio-community/Qwen3.6-27B-GGUF", "unsloth/Qwen3.6-27B-MTP-GGUF"]);
    expect(orderRepos("Qwen", [quants[0]!], [])).toEqual(["unsloth/Qwen3.6-27B-MTP-GGUF"]);
    expect(orderRepos("Qwen", [{ id: "unsloth/Empty-GGUF", downloads: 5 }, { id: "unsloth/Qwen3-Next-80B-GGUF", downloads: 4 }], [])).toEqual(["unsloth/Empty-GGUF", "unsloth/Qwen3-Next-80B-GGUF"]); // 'Next' is not 'MTP'
  });

  test("the maker's own '<name>-GGUF' repository without a base_model tag is added from the discovery lists; repeats removed; at most three are tried", () => {
    const quants = [{ id: "bartowski/Ornith-1.5-9B-GGUF", downloads: 26422 }, { id: "AtomicChat/Ornith-1.5-9B-GGUF", downloads: 49053 }];
    expect(orderRepos("ornith-ai", quants, [{ id: "ornith-ai/Ornith-1.5-9B-GGUF", downloads: 5059834 }, { id: "bartowski/Ornith-1.5-9B-GGUF", downloads: 26422 }]))
      .toEqual(["ornith-ai/Ornith-1.5-9B-GGUF", "bartowski/Ornith-1.5-9B-GGUF"]);
    const many = ["unsloth", "bartowski", "lmstudio-community", "ggml-org"].map((a, i) => ({ id: `${a}/x-GGUF`, downloads: 100 - i }));
    expect(orderRepos("Qwen", many, [])).toHaveLength(3);
  });
});
