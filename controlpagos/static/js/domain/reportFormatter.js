(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ControlPagosReportFormatter = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function formatMoney(amount) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(amount || 0));
  }

  function buildGroupReportMessage(name, type, items, options) {
    const config = options || {};
    const locale = config.locale || "es-EC";
    const validItems = (items || []).filter((item) => !item.isNote);

    if (!validItems.length) {
      return "";
    }

    const total = validItems.reduce((sum, item) => {
      return sum + Number(type === "classes" ? item.hours : item.amount);
    }, 0);
    const totalStr = type === "classes" ? `${total} horas` : formatMoney(total);

    let text = `*Persona: ${name}*\n`;
    text += "--------------------------------\n";
    text += `*TOTAL PENDIENTE: ${totalStr}*\n`;
    text += "--------------------------------\n";
    text += "*DETALLE:*\n";

    validItems.forEach((item) => {
      const value = type === "classes" ? `${item.hours}h` : formatMoney(item.amount);
      const date = new Date(item.date).toLocaleDateString(locale);
      const detail = String(item.desc || "").trim() || "Sin detalle";
      text += `* ${date} | ${value} | ${detail}\n`;
    });

    text += "----------------------------------------------\n";
    text += "Generado por ControlPagos";

    return text;
  }

  return {
    buildGroupReportMessage,
    formatMoney,
  };
});
