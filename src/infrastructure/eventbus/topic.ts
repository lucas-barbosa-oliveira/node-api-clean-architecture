/** Casa uma routing key com um padrão de binding de exchange topic (* = uma palavra, # = zero ou mais). */
export function topicMatches(pattern: string, routingKey: string): boolean {
    const match = (p: string[], k: string[]): boolean => {
        if (p.length === 0) return k.length === 0
        const [head, ...rest] = p
        if (head === '#') return match(rest, k) || (k.length > 0 && match(p, k.slice(1)))
        if (k.length === 0) return false
        return (head === '*' || head === k[0]) && match(rest, k.slice(1))
    }
    return match(pattern.split('.'), routingKey.split('.'))
}
