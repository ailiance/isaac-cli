export const QUOTES = [
	// ISAAC / souveraineté
	"Souverain par conception : tes données, ton modèle, ton matériel.",
	"La traçabilité n'est pas une contrainte, c'est une preuve.",
	"Un agent qui s'explique vaut mieux qu'un agent qui impressionne.",
	"Du schéma au silicium, sans quitter l'Europe.",
	"ISAAC — intelligence souveraine, du prompt au produit.",
	// Craft électronique / code
	"Measure the trace, then cut the code.",
	"Le meilleur bug est celui qui n'atteint jamais le PCB.",
	"Tests green, board clean.",
	"L'élégance, c'est ce qui reste quand le DRC passe.",
]

export const getRandomQuote = () => {
	return QUOTES[Math.floor(Math.random() * QUOTES.length)]
}
