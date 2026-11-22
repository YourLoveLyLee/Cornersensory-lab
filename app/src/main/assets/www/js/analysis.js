(function (global) {
  "use strict";

  const CORNERS = ["TL", "TR", "BL", "BR"];
  const CORNER_NAMES = {
    TL: "TOP LEFT",
    TR: "TOP RIGHT",
    BL: "BOTTOM LEFT",
    BR: "BOTTOM RIGHT",
  };

  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function std(arr, m = null) {
    if (arr.length < 2) return 0;
    const mu = m === null ? mean(arr) : m;
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mu;
      s += d * d;
    }
    return Math.sqrt(s / (arr.length - 1));
  }

  function buildFeatureKeys(includeGyro) {
    const keys = [
      { key: "firstX", label: "First Impulse X" },
      { key: "firstY", label: "First Impulse Y" },
      { key: "firstZ", label: "First Impulse Z" },
      { key: "signedPeakX", label: "Signed Peak X" },
      { key: "signedPeakY", label: "Signed Peak Y" },
      { key: "signedPeakZ", label: "Signed Peak Z" },
      { key: "energyRatioX", label: "Energy Ratio X" },
      { key: "energyRatioY", label: "Energy Ratio Y" },
      { key: "energyRatioZ", label: "Energy Ratio Z" },
      { key: "durationMs", label: "Vibration Duration" },
    ];
    if (includeGyro) {
      keys.push(
        { key: "signedRa", label: "Gyro Peak α (Z)" },
        { key: "signedRb", label: "Gyro Peak β (X)" },
        { key: "signedRg", label: "Gyro Peak γ (Y)" }
      );
    }
    return keys;
  }

  function extractVector(tap, featureDefs) {
    return featureDefs.map((f) => {
      const v = tap[f.key];
      return Number.isFinite(v) ? v : 0;
    });
  }

  function cosineSimilarity(a, b) {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function euclideanDist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  function computeStandardizer(vectors) {
    const dims = vectors[0].length;
    const means = new Array(dims).fill(0);
    const stds = new Array(dims).fill(1);
    const n = vectors.length;

    for (let d = 0; d < dims; d++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += vectors[i][d];
      means[d] = s / n;
    }
    for (let d = 0; d < dims; d++) {
      let sq = 0;
      for (let i = 0; i < n; i++) {
        const diff = vectors[i][d] - means[d];
        sq += diff * diff;
      }
      const sd = n > 1 ? Math.sqrt(sq / (n - 1)) : 1;
      stds[d] = sd > 1e-6 ? sd : 1;
    }
    return { means, stds };
  }

  function standardize(vec, stdzer) {
    return vec.map((v, i) => (v - stdzer.means[i]) / stdzer.stds[i]);
  }

  function analyzeExperiment(datasetByCorner) {
    const allSamples = [];
    for (const c of CORNERS) {
      const list = datasetByCorner[c] || [];
      for (const tap of list) {
        allSamples.push({ corner: c, tap });
      }
    }

    const counts = {};
    for (const c of CORNERS) counts[c] = (datasetByCorner[c] || []).length;
    const totalCount = allSamples.length;
    const activeCorners = CORNERS.filter((c) => counts[c] > 0);
    const gyroAllPresent =
      totalCount > 0 && allSamples.every((s) => s.tap.gyroAvailable);

    const featureDefs = buildFeatureKeys(gyroAllPresent);

    // Per-corner summary stats
    const cornerStats = {};
    for (const c of CORNERS) {
      const list = datasetByCorner[c] || [];
      if (!list.length) {
        cornerStats[c] = null;
        continue;
      }
      const peakMags = list.map((t) => t.peakMag);
      const meanXs = list.map((t) => t.meanAbsX);
      const meanYs = list.map((t) => t.meanAbsY);
      const meanZs = list.map((t) => t.meanAbsZ);
      const peakXs = list.map((t) => t.peakX);
      const peakYs = list.map((t) => t.peakY);
      const peakZs = list.map((t) => t.peakZ);
      const durs = list.map((t) => t.durationMs);

      cornerStats[c] = {
        corner: c,
        name: CORNER_NAMES[c],
        n: list.length,
        meanPeakMag: +mean(peakMags).toFixed(2),
        maxPeakMag: +Math.max(...peakMags).toFixed(2),
        stdPeakMag: +std(peakMags).toFixed(2),
        meanX: +mean(meanXs).toFixed(2),
        stdX: +std(meanXs).toFixed(2),
        peakX: +Math.max(...peakXs).toFixed(2),
        meanY: +mean(meanYs).toFixed(2),
        stdY: +std(meanYs).toFixed(2),
        peakY: +Math.max(...peakYs).toFixed(2),
        meanZ: +mean(meanZs).toFixed(2),
        stdZ: +std(meanZs).toFixed(2),
        peakZ: +Math.max(...peakZs).toFixed(2),
        meanDurMs: +mean(durs).toFixed(1),
        stdDurMs: +std(durs).toFixed(1),
      };
    }

    // Check sufficiency
    const cornersWithMinSamples = CORNERS.filter((c) => counts[c] >= 3);
    if (cornersWithMinSamples.length < 2 || totalCount < 6) {
      return {
        ready: false,
        totalCount,
        counts,
        gyroAllPresent,
        cornerStats,
        anova: [],
        similarityMatrix: null,
        confusionMatrix: null,
        accuracy: null,
        kappa: null,
        classifierModel: null,
        verdict: {
          code: "INSUFFICIENT_DATA",
          badge: "INSUFFICIENT DATA",
          isPositive: false,
          summary:
            "Need at least 3 taps across 2+ corners (recommended: 10 taps on all 4 corners) to run cross-validated statistical analysis.",
        },
      };
    }

    // 1. One-way ANOVA F-stat & eta^2 across corners with >= 2 samples
    const anovaCorners = CORNERS.filter((c) => counts[c] >= 2);
    const anovaResults = [];
    if (anovaCorners.length >= 2) {
      for (const f of featureDefs) {
        const groups = anovaCorners.map((c) =>
          (datasetByCorner[c] || []).map((t) => (Number.isFinite(t[f.key]) ? t[f.key] : 0))
        );
        const flat = groups.flat();
        const grandMean = mean(flat);
        let ssBetween = 0;
        let ssWithin = 0;
        for (const g of groups) {
          const gm = mean(g);
          ssBetween += g.length * Math.pow(gm - grandMean, 2);
          for (const val of g) ssWithin += Math.pow(val - gm, 2);
        }
        const dfB = groups.length - 1;
        const dfW = Math.max(1, flat.length - groups.length);
        const msB = ssBetween / dfB;
        const msW = ssWithin / dfW;
        const fStat = msW > 1e-9 ? msB / msW : 0;
        const ssTotal = ssBetween + ssWithin;
        const etaSq = ssTotal > 1e-9 ? ssBetween / ssTotal : 0;
        anovaResults.push({
          key: f.key,
          label: f.label,
          fStat: +fStat.toFixed(2),
          etaSq: +etaSq.toFixed(3),
        });
      }
      anovaResults.sort((a, b) => b.fStat - a.fStat);
    }

    // 2. Full standardized feature vectors & pairwise similarity matrix
    const rawVectors = allSamples.map((s) => extractVector(s.tap, featureDefs));
    const fullStdzer = computeStandardizer(rawVectors);
    const stdVectors = rawVectors.map((v) => standardize(v, fullStdzer));

    const centroids = {};
    for (const c of activeCorners) {
      const idxs = [];
      for (let i = 0; i < allSamples.length; i++) {
        if (allSamples[i].corner === c) idxs.push(i);
      }
      const dims = featureDefs.length;
      const cent = new Array(dims).fill(0);
      for (const idx of idxs) {
        for (let d = 0; d < dims; d++) cent[d] += stdVectors[idx][d];
      }
      for (let d = 0; d < dims; d++) cent[d] /= idxs.length;
      centroids[c] = cent;
    }

    const similarityMatrix = {};
    for (const c1 of CORNERS) {
      similarityMatrix[c1] = {};
      for (const c2 of CORNERS) {
        if (!centroids[c1] || !centroids[c2]) {
          similarityMatrix[c1][c2] = null;
        } else {
          const cos = cosineSimilarity(centroids[c1], centroids[c2]);
          const dist = euclideanDist(centroids[c1], centroids[c2]);
          similarityMatrix[c1][c2] = {
            cosine: +cos.toFixed(3),
            similarityPct: +(((cos + 1) / 2) * 100).toFixed(1),
            distance: +dist.toFixed(2),
          };
        }
      }
    }

    // 3. Leave-One-Out Cross-Validation (Nearest-Centroid on z-scored features)
    // Only evaluate corners that have >= 2 samples so leaving one out leaves >= 1 training sample
    const evalIndices = [];
    for (let i = 0; i < allSamples.length; i++) {
      if (counts[allSamples[i].corner] >= 2) evalIndices.push(i);
    }

    const matrix = {};
    for (const actual of CORNERS) {
      matrix[actual] = {};
      for (const pred of CORNERS) matrix[actual][pred] = 0;
    }

    let correctCount = 0;
    const evalCorners = CORNERS.filter((c) => counts[c] >= 2);

    for (const testIdx of evalIndices) {
      const trainIndices = evalIndices.filter((idx) => idx !== testIdx);
      const trainRaw = trainIndices.map((idx) => rawVectors[idx]);
      const stdzer = computeStandardizer(trainRaw);

      // Compute training centroids excluding testIdx
      const looCentroids = {};
      for (const c of evalCorners) {
        const cVecs = [];
        for (const idx of trainIndices) {
          if (allSamples[idx].corner === c) {
            cVecs.push(standardize(rawVectors[idx], stdzer));
          }
        }
        const dims = featureDefs.length;
        const cent = new Array(dims).fill(0);
        for (const v of cVecs) {
          for (let d = 0; d < dims; d++) cent[d] += v[d];
        }
        for (let d = 0; d < dims; d++) cent[d] /= cVecs.length;
        looCentroids[c] = cent;
      }

      const testStd = standardize(rawVectors[testIdx], stdzer);
      let bestCorner = evalCorners[0];
      let bestDist = Infinity;
      for (const c of evalCorners) {
        const d = euclideanDist(testStd, looCentroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCorner = c;
        }
      }

      const actual = allSamples[testIdx].corner;
      matrix[actual][bestCorner]++;
      if (actual === bestCorner) correctCount++;
    }

    const evaluatedN = evalIndices.length;
    const accuracy = evaluatedN > 0 ? (correctCount / evaluatedN) * 100 : 0;

    // Cohen's kappa
    let pe = 0;
    for (const c of evalCorners) {
      let rowSum = 0;
      let colSum = 0;
      for (const c2 of evalCorners) {
        rowSum += matrix[c][c2];
        colSum += matrix[c2][c];
      }
      pe += (rowSum / evaluatedN) * (colSum / evaluatedN);
    }
    const po = evaluatedN > 0 ? correctCount / evaluatedN : 0;
    const kappa = pe < 0.9999 ? (po - pe) / (1 - pe) : 0;

    // Honest verdict calculation
    const allFourComplete = CORNERS.every((c) => counts[c] >= 10);
    const allFourPresent = evalCorners.length === 4;
    const randomBaseline = (100 / Math.max(2, evalCorners.length)).toFixed(1);

    let verdict;
    if (!allFourPresent) {
      verdict = {
        code: "PARTIAL_CORNERS",
        badge: `PARTIAL (${evalCorners.length}/4 CORNERS)`,
        isPositive: false,
        summary: `Only ${evalCorners.length} corners have ≥2 samples. Collect all 4 corners (10 taps each) before concluding controller feasibility.`,
      };
    } else if (accuracy < 38 || kappa < 0.16) {
      verdict = {
        code: "NOT_DISTINGUISHABLE",
        badge: "NOT DISTINGUISHABLE",
        isPositive: false,
        summary: `LOOCV accuracy (${accuracy.toFixed(1)}%) is close to random chance (${randomBaseline}%). Corner vibration signatures overlap too heavily for reliable controller button emulation.${!gyroAllPresent ? " Note: Gyroscope was unavailable, limiting rotational roll/pitch cues." : ""}`,
      };
    } else if (accuracy < 65 || kappa < 0.52) {
      verdict = {
        code: "WEAK_SEPARATION",
        badge: "WEAK / PARTIAL SEPARATION",
        isPositive: false,
        summary: `LOOCV accuracy is ${accuracy.toFixed(1)}% (κ=${kappa.toFixed(2)}). Some directional bias exists, but misclassification rate is too high for dependable controller buttons.`,
      };
    } else if (accuracy < 85 || !allFourComplete) {
      verdict = {
        code: "MODERATE_SEPARATION",
        badge: allFourComplete ? "MODERATE SEPARATION" : "PRELIMINARY SEPARATION",
        isPositive: accuracy >= 70,
        summary: `LOOCV accuracy reached ${accuracy.toFixed(1)}% (κ=${kappa.toFixed(2)}).${!allFourComplete ? " Finish 10 taps per corner to confirm statistical stability." : " Signatures show measurable differences, though occasional misclassifications remain."}`,
      };
    } else {
      verdict = {
        code: "DISTINGUISHABLE",
        badge: "STATISTICALLY DISTINGUISHABLE",
        isPositive: true,
        summary: `Strong cross-validated separation (${accuracy.toFixed(1)}%, κ=${kappa.toFixed(2)}) across all 4×10 corner samples. Top separator: ${anovaResults[0]?.label || "multi-axis impulse"}.`,
      };
    }

    return {
      ready: true,
      totalCount,
      evaluatedN,
      counts,
      evalCorners,
      gyroAllPresent,
      cornerStats,
      anova: anovaResults,
      similarityMatrix,
      confusionMatrix: matrix,
      accuracy: +accuracy.toFixed(1),
      kappa: +kappa.toFixed(3),
      randomBaseline: +randomBaseline,
      verdict,
      classifierModel: {
        featureDefs,
        stdzer: fullStdzer,
        centroids,
        evalCorners,
      },
    };
  }

  function classifyLiveTap(tap, model) {
    if (!model || !model.evalCorners || model.evalCorners.length < 2) {
      return null;
    }
    const raw = extractVector(tap, model.featureDefs);
    const zVec = standardize(raw, model.stdzer);

    const distances = {};
    let bestCorner = null;
    let bestDist = Infinity;

    for (const c of model.evalCorners) {
      const d = euclideanDist(zVec, model.centroids[c]);
      distances[c] = +d.toFixed(2);
      if (d < bestDist) {
        bestDist = d;
        bestCorner = c;
      }
    }

    // Softmax inverse distance confidence
    let expSum = 0;
    const weights = {};
    for (const c of model.evalCorners) {
      const w = Math.exp(-distances[c] * 0.85);
      weights[c] = w;
      expSum += w;
    }
    const confidence = expSum > 0 ? (weights[bestCorner] / expSum) * 100 : 0;

    return {
      predicted: bestCorner,
      predictedName: CORNER_NAMES[bestCorner] || bestCorner,
      confidence: +confidence.toFixed(1),
      distances,
      probabilities: Object.fromEntries(
        model.evalCorners.map((c) => [c, +((weights[c] / expSum) * 100).toFixed(1)])
      ),
    };
  }

  global.CornerSense = global.CornerSense || {};
  global.CornerSense.Analysis = {
    CORNERS,
    CORNER_NAMES,
    analyzeExperiment,
    classifyLiveTap,
  };
})(window);
