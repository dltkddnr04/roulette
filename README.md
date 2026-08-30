# Marble Roulette

[lazygyu/roulette](https://github.com/lazygyu/roulette)를 기반으로 한 Marble Roulette 포크입니다.

원본의 디자인과 사용 방식은 그대로 유지하면서 광고·추적을 제거하고, 고해상도/고주사율 환경에 맞게 렌더링과 시뮬레이션을 개선하고, 자체 호스팅과 로컬 Sponsor 기능을 추가했습니다.

## 왜 만들었나요?

군교회에서 예배 후 점심식사 설거지 담당자를 뽑기 위해 Marble Roulette를 사용하던 중 하필 암호화폐 광고가 나타났습니다.

그 자리에서 “상욱 형제, 이 광고 뭡니까? 혹시 상욱 형제가 돈 받은 것은 아니죠?”라는 농담을 전 교인 앞에서 듣고, 그날 광고를 제거하려고 급하게 포크했습니다.

처음 목적은 정말 광고 제거뿐이었습니다. 그런데 기왕 행사용으로 계속 쓸 거라면 화질도 올려보자는 생각이 들었고, 움직임과 시뮬레이션도 손보기 시작했고, Sponsor 기능까지 추가하게 됐습니다.

**원본 Marble Roulette의 경험과 디자인은 유지하고, 내부를 더 나은 방향으로 바꿉니다.**

## 주요 변경점

- 상업 광고, 외부 광고/키워드 API, 추적 및 분석 코드 제거
- DPR-aware 렌더링과 **Performance 0.5x / Native 1x** 화질 모드
- 고주사율 디스플레이를 위한 렌더 보간과 주사율 독립적인 카메라 움직임
- Box2D를 고정 **10 ms** 스텝으로 유지하고 렌더링과 시뮬레이션 시간을 분리
- 로컬 이미지 기반 **Branding & Sponsors** 기능
- Cloudflare Workers Static Assets 기반 자체 호스팅
- 입력, 녹화, 에셋 로딩 및 여러 렌더링 예외 처리 강화

## 다음 목표

방송에서 참가자를 더 쉽게 받을 수 있도록 Twitch/CHZZK 채팅의 `/join` 명령과 QR/Web 참가 기능을 검토하고 있습니다.

## 개발

```sh
yarn
yarn dev
```

```sh
yarn build
yarn deploy
```

## 라이선스

[MIT License](LICENSE)로 배포됩니다.

원본 프로젝트: [Marble Roulette](https://lazygyu.github.io/roulette/) by [LazyGyu](https://github.com/lazygyu)
