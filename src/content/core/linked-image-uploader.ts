// @ts-nocheck
(function initLinkedImageUploader() {
  "use strict";

  if (window.CoreLinkedImageUploader) {
    return;
  }

  const ROOT_ID = "yishe-linked-image-upload-root";
  const IMAGE_EXTENSION_PATTERN =
    /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
  const IMAGE_FORMAT_VALUES = new Set([
    "avif",
    "bmp",
    "gif",
    "heic",
    "heif",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "webp",
  ]);

  const state = {
    activeHoverTarget: null,
    sourceElement: null,
    imageUrl: "",
    hideTimer: null,
    positionFrame: null,
    uploading: false,
  };

  function normalizeHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }

    try {
      const url = new URL(value.trim(), window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function looksLikeImageUrl(value) {
    const normalized = normalizeHttpUrl(value);
    if (!normalized) {
      return false;
    }

    const url = new URL(normalized);
    if (IMAGE_EXTENSION_PATTERN.test(url.pathname)) {
      return true;
    }

    for (const key of ["format", "fm", "ext", "type"]) {
      const format = String(url.searchParams.get(key) || "")
        .trim()
        .toLowerCase()
        .replace(/^image\//, "");
      if (IMAGE_FORMAT_VALUES.has(format)) {
        return true;
      }
    }

    return false;
  }

  function getImageUrlFromElement(element) {
    if (!(element instanceof HTMLImageElement)) {
      return "";
    }

    const candidates = [
      element.currentSrc,
      element.src,
      element.getAttribute("data-src"),
      element.getAttribute("data-original"),
      element.getAttribute("data-lazy-src"),
      element.getAttribute("data-url"),
    ];

    for (const candidate of candidates) {
      const normalized = normalizeHttpUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  function getBackgroundImageUrl(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    try {
      const backgroundImage = window.getComputedStyle(element).backgroundImage;
      const match = backgroundImage?.match(/url\((['"]?)(.*?)\1\)/i);
      return normalizeHttpUrl(match?.[2] || "");
    } catch {
      return "";
    }
  }

  function findAnchorFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const item of path) {
      if (item instanceof HTMLAnchorElement && item.href) {
        return item;
      }
    }

    return event.target instanceof Element
      ? event.target.closest("a[href]")
      : null;
  }

  function findImageFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const item of path) {
      if (item instanceof HTMLImageElement) {
        return item;
      }
    }

    return event.target instanceof Element
      ? event.target.closest("img")
      : null;
  }

  function resolveLinkedImage(anchor, eventTarget) {
    const hoveredImage =
      eventTarget instanceof Element ? eventTarget.closest("img") : null;

    if (!(anchor instanceof HTMLAnchorElement)) {
      const imageUrl = getImageUrlFromElement(hoveredImage);
      if (!imageUrl || !hoveredImage?.isConnected) {
        return null;
      }
      return {
        anchor: null,
        hoverTarget: hoveredImage,
        sourceElement: hoveredImage,
        imageUrl,
      };
    }

    if (!anchor.isConnected) {
      return null;
    }

    if (hoveredImage && anchor.contains(hoveredImage) && eventTarget === hoveredImage) {
      const imageUrl = getImageUrlFromElement(hoveredImage);
      if (imageUrl) {
        return {
          anchor,
          hoverTarget: anchor,
          sourceElement: hoveredImage,
          imageUrl,
        };
      }
    }

    const href = normalizeHttpUrl(anchor.href);
    const anchorType = String(anchor.getAttribute("type") || "").toLowerCase();
    if (href && (looksLikeImageUrl(href) || anchorType.startsWith("image/"))) {
      return {
        anchor,
        hoverTarget: anchor,
        sourceElement: anchor,
        imageUrl: href,
      };
    }

    if (hoveredImage && anchor.contains(hoveredImage)) {
      const imageUrl = getImageUrlFromElement(hoveredImage);
      if (imageUrl) {
        return {
          anchor,
          hoverTarget: anchor,
          sourceElement: hoveredImage,
          imageUrl,
        };
      }
    }

    const childImage = anchor.querySelector("img");
    const childImageUrl = getImageUrlFromElement(childImage);
    if (childImageUrl) {
      return {
        anchor,
        hoverTarget: anchor,
        sourceElement: childImage,
        imageUrl: childImageUrl,
      };
    }

    const backgroundSource =
      eventTarget instanceof Element && anchor.contains(eventTarget)
        ? eventTarget
        : anchor;
    const backgroundUrl =
      getBackgroundImageUrl(backgroundSource) || getBackgroundImageUrl(anchor);
    if (backgroundUrl) {
      return {
        anchor,
        hoverTarget: anchor,
        sourceElement: backgroundSource,
        imageUrl: backgroundUrl,
      };
    }

    return null;
  }

  function createRoot() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-yishe-extension-ui", "linked-image-uploader");
    root.innerHTML = `
      <button
        class="yishe-linked-image-upload-button"
        type="button"
        title="上传图片到 YiShe 图库"
        aria-label="上传图片到 YiShe 图库"
      >
        <span class="yishe-linked-image-upload-icon" aria-hidden="true">↑</span>
        <span class="yishe-linked-image-upload-label">上传到图库</span>
      </button>
    `;

    const button = root.querySelector("button");
    button.addEventListener("click", handleUploadClick);
    root.addEventListener("pointerenter", cancelHide);
    root.addEventListener("pointerleave", scheduleHide);
    document.documentElement.appendChild(root);
    return root;
  }

  const root = createRoot();
  const button = root.querySelector("button");
  const label = root.querySelector(".yishe-linked-image-upload-label");

  function setButtonState(nextState) {
    root.classList.toggle("is-uploading", nextState === "uploading");
    root.classList.toggle("is-success", nextState === "success");
    root.classList.toggle("is-error", nextState === "error");
    button.disabled = nextState === "uploading";

    if (nextState === "uploading") {
      label.textContent = "上传中";
    } else if (nextState === "success") {
      label.textContent = "已上传";
    } else if (nextState === "error") {
      label.textContent = "上传失败";
    } else {
      label.textContent = "上传到图库";
    }
  }

  function cancelHide() {
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function hide() {
    if (state.uploading) {
      return;
    }
    cancelHide();
    root.classList.remove("is-visible");
    state.activeHoverTarget = null;
    state.sourceElement = null;
    state.imageUrl = "";
    setButtonState("idle");
  }

  function scheduleHide() {
    cancelHide();
    state.hideTimer = setTimeout(() => {
      const targetHovered = state.activeHoverTarget?.matches?.(":hover");
      if (!state.uploading && !root.matches(":hover") && !targetHovered) {
        hide();
      }
    }, 140);
  }

  function positionRoot() {
    state.positionFrame = null;

    const source = state.sourceElement || state.activeHoverTarget;
    if (!source?.isConnected || !root.classList.contains("is-visible")) {
      hide();
      return;
    }

    const rect = source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > innerHeight) {
      hide();
      return;
    }

    const buttonWidth = root.offsetWidth || 92;
    const buttonHeight = root.offsetHeight || 28;
    const horizontalInset = 6;
    const verticalInset = 6;
    const top =
      rect.height >= buttonHeight + verticalInset * 2
        ? rect.top + verticalInset
        : rect.bottom + verticalInset;
    const left = rect.left + horizontalInset;

    root.style.top = `${Math.max(6, Math.min(top, innerHeight - buttonHeight - 6))}px`;
    root.style.left = `${Math.max(6, Math.min(left, innerWidth - buttonWidth - 6))}px`;
  }

  function schedulePosition() {
    if (state.positionFrame !== null) {
      return;
    }
    state.positionFrame = requestAnimationFrame(positionRoot);
  }

  function show(resolved) {
    cancelHide();
    const changed =
      state.activeHoverTarget !== resolved.hoverTarget ||
      state.imageUrl !== resolved.imageUrl;
    state.activeHoverTarget =
      resolved.hoverTarget || resolved.anchor || resolved.sourceElement;
    state.sourceElement = resolved.sourceElement;
    state.imageUrl = resolved.imageUrl;
    if (changed && !state.uploading) {
      setButtonState("idle");
    }
    root.classList.add("is-visible");
    schedulePosition();
  }

  function showToast(message, type) {
    if (window.CoreToast?.show) {
      window.CoreToast.show({
        message,
        type: type || "info",
        duration: 3200,
      });
      return;
    }
    console.log("[YiShe][LinkedImageUploader]", type || "info", message);
  }

  function sendUploadMessage(imageUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "uploadImageToGallery",
          imageUrl,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.success) {
            reject(new Error(response?.error || "上传失败"));
            return;
          }
          resolve(response.data || response);
        },
      );
    });
  }

  async function handleUploadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (state.uploading || !state.imageUrl) {
      return;
    }

    const imageUrl = state.imageUrl;
    state.uploading = true;
    setButtonState("uploading");

    try {
      await sendUploadMessage(imageUrl);
      setButtonState("success");
      showToast("图片已上传到 YiShe 图库", "success");
    } catch (error) {
      setButtonState("error");
      showToast(error instanceof Error ? error.message : "图片上传失败", "error");
    } finally {
      state.uploading = false;
      setTimeout(() => {
        if (!state.uploading) {
          setButtonState("idle");
          scheduleHide();
        }
      }, 1200);
    }
  }

  function handlePointerOver(event) {
    if (state.uploading || root.contains(event.target)) {
      return;
    }

    const anchor = findAnchorFromEvent(event);
    const image = findImageFromEvent(event);
    const resolved = resolveLinkedImage(anchor, image || event.target);
    if (resolved) {
      show(resolved);
    }
  }

  function handlePointerOut(event) {
    if (!state.activeHoverTarget) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      (state.activeHoverTarget.contains(relatedTarget) || root.contains(relatedTarget))
    ) {
      return;
    }

    if (
      event.target instanceof Node &&
      state.activeHoverTarget.contains(event.target)
    ) {
      scheduleHide();
    }
  }

  function handleFocusIn(event) {
    const anchor = findAnchorFromEvent(event);
    const image = findImageFromEvent(event);
    const resolved = resolveLinkedImage(anchor, image || event.target);
    if (resolved) {
      show(resolved);
    }
  }

  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("pointerout", handlePointerOut, true);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("focusout", scheduleHide, true);
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  window.CoreLinkedImageUploader = {
    hide,
    resolveLinkedImage,
  };
})();
