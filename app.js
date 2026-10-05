let cartCount = 0;

const cartCountElement = document.getElementById("cartCount");
const cartButton = document.getElementById("cartButton");

function updateCart() {
  cartCountElement.textContent = cartCount;
}

function addToCart() {
  cartCount++;

  updateCart();

  const button = event.currentTarget;

  const originalText = button.textContent;

  button.textContent = "✓ Додано";

  setTimeout(() => {
    button.textContent = originalText;
  }, 1200);
}

cartButton.addEventListener("click", () => {
  if (cartCount === 0) {
    alert("🛒 Кошик поки порожній.");
    return;
  }

  alert(
    `🛒 У кошику товарів: ${cartCount}\n\n` +
    "Повноцінний кошик підключимо на наступному етапі."
  );
});

updateCart();
