/* 코인 로고. 공개 아이콘 모음 cryptocurrency-icons (MIT, jsdelivr)에서 불러오고,
 * 모음에 없는 코인(신생 코인 등)은 첫 글자를 넣은 동그라미로 대신한다.
 * 로고는 각 코인 프로젝트의 상표이며 이름 옆 표시용으로만 쓴다.
 */
"use strict";

const COIN_LOGO = {
  url(sym) {
    return `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${sym.toLowerCase()}.svg`;
  },
  /** 기호(BTC 등)마다 늘 같은 색 */
  color(sym) {
    let h = 0;
    for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 45% 42%)`;
  },
  /** <span class="coin-logo"> 요소를 만든다. sym 은 "BTC" 처럼 */
  el(sym, size = 28) {
    const wrap = document.createElement("span");
    wrap.className = "coin-logo";
    wrap.style.setProperty("--sz", `${size}px`);
    const img = new Image(size, size);
    img.alt = "";
    img.decoding = "async";
    img.onerror = () => {
      wrap.replaceChildren();
      wrap.classList.add("fallback");
      wrap.style.background = this.color(sym);
      wrap.textContent = sym.slice(0, 1);
    };
    img.src = this.url(sym);
    wrap.append(img);
    return wrap;
  },
};
