// Shared geometry keeps the startup ring aligned with the interactive core.
export function sceneLayout(width, height) {
  return {
    scale: width <= 900 ? Math.min(width * .0015, height / 850, 1) : Math.min(width / 1672, height / 941),
    x: width * (width <= 900 ? .50 : .495),
    y: height * (width <= 900 ? .42 : .46),
  };
}
