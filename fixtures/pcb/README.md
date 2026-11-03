# Attributed PCB candidate-patch examples

These four unmodified 300×300 JPEGs are from **PCB-IND v4**, by **Hao Yan,
Fujian Polytechnic Normal University**, [Zenodo record 19723114](https://zenodo.org/records/19723114),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The source-code license does not relicense these images or the trained weights.

`manifest.json` records byte hashes, original archive paths, frozen study splits,
and selection reasons. The source archive's directory names differ from the
study's audited split. `5810_t_007.jpg` is a **training-set serving smoke fixture**.
The other three are already-published frozen-holdout examples: an evenly sampled
scratch, an evenly sampled stain predicted as spurious copper, and the recorded
maximum-missed-defect example. They illustrate successes and failures; their
selection is not representative enough to estimate accuracy.

Use them with the optional trained mode and its explicit candidate-patch
attestation. Do not upload synthetic mock fixtures or full-board images as trained
domain examples. Scores are uncalibrated, and human corrections are application
data; they do not update the model.
