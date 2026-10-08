"""把 HuggingFace 上的动物个体识别预训练模型导出成 ONNX。

为什么是这几个模型：MegaDescriptor 是首个专做「野生动物个体识别」的基础模型，
在 29 个公开 ReID 数据集上训练，论文里明确说它显著优于通用的 CLIP 与 DINOv2。
用它你连训练环节都省了 —— 直接获得可用的个体区分能力。

注意 license：MegaDescriptor 权重是 CC BY-NC 4.0（禁止商用）。
校园公益项目没问题；将来要商业化，换成 Apache-2.0 的原生 DINOv2 即可（脚本里给了开关）。
"""
import argparse
import sys
from pathlib import Path

MODEL_CHOICES = {
    # 版权友好的通用选择：Apache-2.0
    "dinov2-s": "timm/vit_small_patch14_dinov2.lvd142m",
    "dinov2-b": "timm/vit_base_patch14_dinov2.lvd142m",
    # 个体识别效果更好，但 CC BY-NC 4.0 不可商用
    "mega-s": "hf-hub:BVRA/MegaDescriptor-S-224",
    "mega-l": "hf-hub:BVRA/MegaDescriptor-L-224",
    "mega-dinov2": "hf-hub:BVRA/MegaDescriptor-DINOv2-518",
}


def export(model_key: str, out: str, size: int, opset: int = 17):
    try:
        import torch
        import timm
    except ImportError:
        sys.exit("需要 pip install torch timm")

    name = MODEL_CHOICES[model_key]
    print(f"加载 {name} ...")
    model = timm.create_model(name, pretrained=True, num_classes=0)
    model.eval()

    dummy = torch.randn(1, 3, size, size)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, dummy, out,
        input_names=["input"], output_names=["embedding"],
        dynamic_axes={"input": {0: "batch"}},
        opset_version=opset,
    )
    print(f"完成 → {out}  (输入 {size}x{size})")
    print(f"在 .env 里配置：REID_ONNX={out}  REID_SIZE={size}")


def export_yolo(weights: str = "yolov8n.pt", out: str = "models/yolov8n.onnx", size: int = 640):
    try:
        from ultralytics import YOLO
    except ImportError:
        sys.exit("需要 pip install ultralytics")

    print(f"导出 {weights} ...")
    YOLO(weights).export(format="onnx", imgsz=size, simplify=True, dynamic=False)
    print(f"完成后在 .env 里配置：DETECT_ONNX={out}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="导出 ReID / 检测权重为 ONNX")
    p.add_argument("--model", choices=list(MODEL_CHOICES), default="mega-l")
    p.add_argument("--out", default="models/reid.onnx")
    p.add_argument("--size", type=int, default=224)
    p.add_argument("--yolo", action="store_true", help="改为导出 YOLO 检测模型")
    p.add_argument("--weights", default="yolov8n.pt")
    a = p.parse_args()

    if a.yolo:
        export_yolo(a.weights, "models/yolo.onnx", 640)
    else:
        default_size = 518 if "518" in a.model or "mega-dinov2" == a.model else 224
        export(a.model, a.out, a.size or default_size)
